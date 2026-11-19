/**
 * QPI types that appear in call I/O. The parser also reads the real QPI
 * headers, but template instantiations and anonymous unions are represented
 * here in their concrete ABI form.
 *
 * These definitions mirror qubic/core exactly. The static_assert sizes in core
 * are noted next to each type so changes are easy to audit. Layout is still
 * computed by the layout engine rather than hard-coded.
 */
export const QPI_BUILTIN_SOURCE = `
struct NoData
{
};

struct Asset
{
	id issuer;
	uint64 assetName;
};

struct DateAndTime
{
	uint64 value;
};

struct ProposalSingleVoteDataV1
{
	uint16 proposalIndex;
	uint16 proposalType;
	uint32 proposalTick;
	sint64 voteValue;
};

struct ProposalMultiVoteDataV1
{
	uint16 proposalIndex;
	uint16 proposalType;
	uint32 proposalTick;
	Array<sint64, 8> voteValues;
	Array<uint32, 8> voteCounts;
};

struct ProposalSummarizedVotingDataV1
{
	uint16 proposalIndex;
	uint16 optionCount;
	uint32 proposalTick;
	uint32 totalVotesAuthorized;
	uint32 totalVotesCasted;
	// union of Array<uint32, 8> optionVoteCount and sint64 scalarVotingResult
	Array<uint32, 8> optionVoteCount;
};

struct ProposalDataYesNo
{
	Array<uint8, 256> url;
	uint16 epoch;
	uint16 type;
	uint32 tick;
	// union Data { Transfer transfer; VariableOptions variableOptions; }
	Array<uint8, 40> data;
};

template <bool SupportScalarVotes>
struct ProposalDataV1
{
	Array<uint8, 256> url;
	uint16 epoch;
	uint16 type;
	uint32 tick;
	// union Data { Transfer transfer; TransferInEpoch transferInEpoch;
	// VariableOptions variableOptions; VariableScalar variableScalar; }
	Array<uint8, 64> data;
};

struct Price
{
	struct OracleQuery
	{
		id oracle;
		DateAndTime timestamp;
		id currency1;
		id currency2;
	};

	struct OracleReply
	{
		sint64 numerator;
		sint64 denominator;
	};
};

struct OracleNotificationInput
{
	sint64 queryId;
	sint32 subscriptionId;
	uint8 status;
	uint8 __reserved0;
	uint16 __reserved1;
	sint64 numerator;
	sint64 denominator;
};
`

/** Convenience aliases from qpi_containers.h that are commonly used in I/O. */
export const QPI_CONTAINER_ALIAS_SOURCE = `
typedef Array<uint8, 2> uint8_2;
typedef Array<uint8, 4> uint8_4;
typedef Array<uint8, 8> uint8_8;
typedef Array<uint16, 2> uint16_2;
typedef Array<uint16, 4> uint16_4;
typedef Array<uint16, 8> uint16_8;
typedef Array<uint32, 2> uint32_2;
typedef Array<uint32, 4> uint32_4;
typedef Array<uint32, 8> uint32_8;
typedef Array<uint64, 2> uint64_2;
typedef Array<uint64, 4> uint64_4;
typedef Array<uint64, 8> uint64_8;
typedef Array<sint8, 2> sint8_2;
typedef Array<sint8, 4> sint8_4;
typedef Array<sint8, 8> sint8_8;
typedef Array<sint16, 2> sint16_2;
typedef Array<sint16, 4> sint16_4;
typedef Array<sint16, 8> sint16_8;
typedef Array<sint32, 2> sint32_2;
typedef Array<sint32, 4> sint32_4;
typedef Array<sint32, 8> sint32_8;
typedef Array<sint64, 2> sint64_2;
typedef Array<sint64, 4> sint64_4;
typedef Array<sint64, 8> sint64_8;
typedef Array<id, 2> id_2;
typedef Array<id, 8> id_4;
typedef Array<id, 8> id_8;
`
