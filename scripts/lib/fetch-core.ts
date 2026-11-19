/**
 * Fetches the qubic/core sources needed for ABI generation.
 *
 * GitHub's raw file endpoint is not rate limited like the REST API, so we
 * resolve the commit and file tree once through the API and then download the
 * handful of headers we need from raw.githubusercontent.com.
 *
 * Set QUBIC_CORE_REF to pin a branch, tag, or commit. Set QUBIC_CORE_DIR to
 * use a local checkout instead of the network (useful for tests and offline
 * regeneration).
 */

import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { promisify } from 'node:util'

export interface CoreSource {
	files: Map<string, string>
	source: {
		repository: 'qubic/core'
		ref: string
		commit: string
		commitDate: string
	}
}

export interface FetchCoreOptions {
	ref?: string
	/** Local qubic/core checkout. When set, no network requests are made. */
	dir?: string
	/** GitHub token; falls back to `GITHUB_TOKEN` from the environment. */
	token?: string
	/** Override for tests. */
	fetchImpl?: typeof fetch
	log?: (message: string) => void
}

const REPOSITORY = 'qubic/core'
const API = 'https://api.github.com'
const execFileAsync = promisify(execFile)

/** Headers that are required to generate an ABI. */
const REQUIRED_PATHS = [
	'src/contract_core/contract_def.h',
	'src/qpi/qpi_types.h',
	'src/qpi/qpi_containers.h',
	'src/qpi/qpi_date_time.h',
	'src/qpi/qpi_proposals.h',
	'src/qpi/qpi_macros.h',
]

interface GitHubCommit {
	sha: string
	commit: { author: { date: string }; committer: { date: string } }
}

interface GitHubTreeEntry {
	path: string
	type: string
}

interface GitHubTree {
	tree: GitHubTreeEntry[]
	truncated?: boolean
}

export async function fetchCoreSource(
	options: FetchCoreOptions = {},
): Promise<CoreSource> {
	if (options.dir) {
		return readLocalSource(options.dir)
	}

	const ref = options.ref ?? process.env.QUBIC_CORE_REF ?? 'main'
	const fetchImpl = options.fetchImpl ?? fetch
	const log = options.log ?? (() => {})
	const headers = githubHeaders(options.token ?? process.env.GITHUB_TOKEN)

	const commit = await fetchJson<GitHubCommit>(
		`${API}/repos/${REPOSITORY}/commits/${encodeURIComponent(ref)}`,
		fetchImpl,
		headers,
	)
	const tree = await fetchJson<GitHubTree>(
		`${API}/repos/${REPOSITORY}/git/trees/${commit.sha}?recursive=1`,
		fetchImpl,
		headers,
	)

	if (tree.truncated) {
		throw new Error(
			'qubic/core tree is truncated; cannot discover contract headers',
		)
	}

	const contractPaths = tree.tree
		.filter(
			(entry) =>
				entry.type === 'blob' && /^src\/contracts\/[^/]+\.h$/.test(entry.path),
		)
		.map((entry) => entry.path)
		.sort()

	const paths = [...new Set([...REQUIRED_PATHS, ...contractPaths])]
	log(`fetching ${paths.length} qubic/core files at ${commit.sha.slice(0, 12)}`)

	const files = new Map<string, string>()
	const concurrency = 8
	for (let index = 0; index < paths.length; index += concurrency) {
		const batch = paths.slice(index, index + concurrency)
		const contents = await Promise.all(
			batch.map(async (path) => {
				const response = await fetchImpl(
					`https://raw.githubusercontent.com/${REPOSITORY}/${commit.sha}/${path}`,
					{ headers },
				)
				if (!response.ok) {
					throw new Error(
						`Failed to fetch ${path}: ${response.status} ${response.statusText}`,
					)
				}
				return [path, await response.text()] as const
			}),
		)
		for (const [path, content] of contents) {
			files.set(path, content)
		}
	}

	return {
		files,
		source: {
			repository: REPOSITORY,
			ref,
			commit: commit.sha,
			commitDate: normalizeDate(commit.commit.committer.date),
		},
	}
}

async function fetchJson<T>(
	url: string,
	fetchImpl: typeof fetch,
	headers: Record<string, string>,
): Promise<T> {
	const response = await fetchImpl(url, {
		headers,
	})
	if (!response.ok) {
		throw new Error(
			`GitHub request failed: ${response.status} ${response.statusText} (${url})`,
		)
	}
	return (await response.json()) as T
}

function githubHeaders(token: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		accept: 'application/vnd.github+json',
		'user-agent': 'glyph-contracts-generator',
	}
	if (token) headers.authorization = `Bearer ${token}`
	return headers
}

async function readLocalSource(dir: string): Promise<CoreSource> {
	const root = await stat(dir).catch(() => null)
	if (!root?.isDirectory()) {
		throw new Error(`QUBIC_CORE_DIR is not a directory: ${dir}`)
	}

	const files = new Map<string, string>()
	const walk = async (relativeDir: string) => {
		const entries = await readdir(join(dir, relativeDir), {
			withFileTypes: true,
		})
		for (const entry of entries) {
			const child = `${relativeDir}/${entry.name}`
			if (entry.isDirectory()) {
				if (entry.name === '.git' || entry.name === 'build') continue
				await walk(child)
				continue
			}
			if (!entry.name.endsWith('.h')) continue
			const absolute = join(dir, child)
			files.set(child.split(sep).join('/'), await readFile(absolute, 'utf8'))
		}
	}
	await walk('src')

	const missing = REQUIRED_PATHS.filter((path) => !files.has(path))
	if (missing.length > 0) {
		throw new Error(
			`Local qubic/core checkout is missing: ${missing.join(', ')}`,
		)
	}

	const commit = (await git(dir, ['rev-parse', 'HEAD'])) ?? 'unknown'
	const branch =
		(await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? commit
	const date = await git(dir, ['show', '-s', '--format=%cI', 'HEAD'])
	const commitDate = normalizeDate(date)

	return {
		files,
		source: {
			repository: REPOSITORY,
			ref: branch,
			commit,
			commitDate,
		},
	}
}

async function git(dir: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('git', ['-C', dir, ...args])
		return stdout.trim() || undefined
	} catch {
		return undefined
	}
}

function normalizeDate(value: string | undefined): string {
	if (value === undefined) return new Date(0).toISOString()
	const parsed = new Date(value)
	return Number.isNaN(parsed.getTime())
		? new Date(0).toISOString()
		: parsed.toISOString()
}

/** Files under `prefix` in the fetched source. */
export function filesUnder(
	source: CoreSource,
	prefix: string,
): Map<string, string> {
	const result = new Map<string, string>()
	const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`
	for (const [path, content] of source.files) {
		if (path.startsWith(normalized))
			result.set(relative(normalized, path), content)
	}
	return result
}
