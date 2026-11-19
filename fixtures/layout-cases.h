// Plain C++ layout cases understood by the QPI ABI subset.
// Expected offsets and sizes are cross-checked against the host C++ compiler
// in the layout tests.

#pragma once

#define CASE_SHORT_ARRAY 3
#define CASE_SCALE 4

enum class CaseStatus : uint8
{
	CASE_PENDING = 1,
	CASE_ACTIVE,
	CASE_DISABLED = CASE_SCALE * 2,
};

struct EmptyCase
{
};

struct ScalarCase
{
	uint8 first;
	uint32 second;
	uint16 third;
	uint64 fourth;
};

struct NestedCase
{
	ScalarCase scalars;
	uint8 tail;
};

struct ArrayCase
{
	uint16 values[CASE_SHORT_ARRAY + 1];
	id ids[2];
};

union UnionCase
{
	uint32 small;
	uint64 large;
	uint8 bytes[10];
};

struct UnionHolder
{
	UnionCase value;
	uint8 tag;
};

struct AlignmentCase
{
	uint8 lead;
	uint128 wide;
	uint8 trail;
};

struct QpiContainersCase
{
	Array<NestedCase, 4> items;
	BitArray<130> bits;
};
