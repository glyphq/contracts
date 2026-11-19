// A small contract written in the Qubic contract style. This fixture is
// original test code, not copied from any contract implementation.

using namespace QPI;

// Second state struct required by the contract loader.
struct SIMPLE2
{
};

// Contract used by the parser and layout tests.
struct SIMPLE : public ContractBase
{
public:
	// Lifecycle value returned by queries.
	enum Status : uint8
	{
		Disabled = 0,
		Enabled = 1,
	};

	// One item stored in contract state.
	struct Item
	{
		id owner;
		uint64 amount;
	};

	struct StateData
	{
		uint64 total;             // Sum of all item amounts.
		Array<Item, 4> items;     // Fixed-size storage.
		bit paused;               // One-byte boolean.
	};

	// No input is sent to Ping.
	struct Ping_input
	{
	};
	// Pong carries a constant marker.
	struct Ping_output
	{
		uint64 value;
	};

	struct Add_input
	{
		id owner;
		uint64 amount;
	};
	struct Add_output
	{
		uint64 total;
	};

	struct Query_input
	{
		uint32 index;
	};
	struct Query_output
	{
		struct Entry
		{
			id owner;
			uint64 amount;
			bool active;
		};

		Array<Entry, 8> entries;
		Status status;
	};

	PUBLIC_FUNCTION(Ping)
	{
		output.value = 7;
	}

	PUBLIC_FUNCTION(Query)
	{
		output.status = Status::Enabled;
	}

	struct Add_locals
	{
		uint64 scratch;
	};

	PUBLIC_PROCEDURE_WITH_LOCALS(Add)
	{
		locals.scratch = input.amount;
	}

	REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
	{
		REGISTER_USER_FUNCTION(Ping, 1);
		REGISTER_USER_FUNCTION(Query, 2);
		REGISTER_USER_PROCEDURE(Add, 1);
	}
};
