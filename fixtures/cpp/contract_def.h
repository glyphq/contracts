#pragma once

////////// Smart contracts \\\\\\\\\\

#define FIRST_CONTRACT_INDEX 1
#define CONTRACT_INDEX FIRST_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE FIRST
#define CONTRACT_STATE2_TYPE FIRST2
#include "contracts/First.h"

#undef CONTRACT_INDEX
#undef CONTRACT_STATE_TYPE
#undef CONTRACT_STATE2_TYPE

#define SECOND_CONTRACT_INDEX 2
#define CONTRACT_INDEX SECOND_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE SECOND
#define CONTRACT_STATE2_TYPE SECOND2
#include "contracts/Second.h"

constexpr struct ContractDescription
{
	char assetName[8];
	unsigned short constructionEpoch, destructionEpoch;
	unsigned long long stateSize;
} contractDescriptions[] = {
	{"", 0, 0, sizeof(Contract0State)},
	{"FIRST", 10, 10000, sizeof(FIRST::StateData)},
	{"SECOND", 20, 10000, sizeof(SECOND::StateData)},
#ifdef INCLUDE_CONTRACT_TEST_EXAMPLES
	{"TEST", 30, 10000, sizeof(TEST::StateData)},
#endif
};

#ifdef INCLUDE_CONTRACT_TEST_EXAMPLES
#define TEST_CONTRACT_INDEX 3
#define CONTRACT_STATE_TYPE TEST
#include "contracts/Test.h"
#endif
