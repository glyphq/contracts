// Realistic contract fixture using constants, nested structs, arrays, and
// QPI collections. Original test code modelled on the Qubic contract style.

using namespace QPI;

// Log event identifiers.
enum TOKENLog : uint8
{
	TOKEN_TRADE = 4,
	TOKEN_ISSUE = 5,
	TOKEN_FAILED = 10,
};

// Fixed constants.
constexpr uint64 TOKEN_MAX_ORDERS = 8192;
constexpr uint64 TOKEN_SLOTS = TOKEN_MAX_ORDERS * X_MULTIPLIER;
constexpr uint64 TOKEN_ORDER_CAPACITY = TOKEN_SLOTS * 16;
constexpr uint32 TOKEN_FEE_BASE = 100;

struct TOKEN2
{
};

struct TOKEN : public ContractBase
{
public:
	struct AssetOrder
	{
		id entity;
		sint64 numberOfShares;
	};

	struct EntityOrder
	{
		id issuer;
		uint64 assetName;
		sint64 numberOfShares;
	};

	struct TradeMessage
	{
		uint32 _contractIndex;
		uint32 _type;
		id issuer;
		uint64 assetName;
		sint64 price;
		sint64 numberOfShares;
		sint8 _terminator;
	};

	struct _NumberOfReservedShares_input
	{
		id issuer;
		uint64 assetName;
	};
	struct _NumberOfReservedShares_output
	{
		sint64 numberOfShares;
	};

	struct Fees_input
	{
	};
	struct Fees_output
	{
		uint32 issuanceFee;  // Amount of qus.
		uint32 transferFee;  // Amount of qus.
		uint32 tradeFee;     // Billionths.
	};

	struct Orders_input
	{
		id issuer;
		uint64 assetName;
		uint64 offset;
	};
	struct Orders_output
	{
		struct Order
		{
			id entity;
			sint64 price;
			sint64 numberOfShares;
		};

		Array<Order, 256> orders;
	};

	struct Issue_input
	{
		uint64 assetName;
		sint64 numberOfShares;
		uint64 unitOfMeasurement;
		sint8 numberOfDecimalPlaces;
	};
	struct Issue_output
	{
		sint64 issuedNumberOfShares;
	};

	struct Transfer_input
	{
		Asset asset;
		sint64 numberOfShares;
		uint32 newManagingContractIndex;
	};
	struct Transfer_output
	{
		sint64 transferredNumberOfShares;
	};

	struct StateData
	{
		uint64 earnedAmount;
		uint64 distributedAmount;
		uint64 burnedAmount;

		uint32 issuanceFee;
		uint32 transferFee;
		uint32 tradeFee;

		Collection<AssetOrder, TOKEN_SLOTS> assetOrders;
		Collection<EntityOrder, TOKEN_SLOTS> entityOrders;

		sint64 elementIndex, elementIndex2;
		id issuerAndAssetName;
		AssetOrder assetOrder;
		EntityOrder entityOrder;
		sint64 price;
		sint64 fee;
		Orders_output::Order askOrder;
		Orders_output::Order bidOrder;
		TradeMessage tradeMessage;
		_NumberOfReservedShares_input reservedInput;
		_NumberOfReservedShares_output reservedOutput;
	};

protected:
	struct _NumberOfReservedShares_locals
	{
		sint64 elementIndex;
		EntityOrder entityOrder;
	};

	PRIVATE_FUNCTION_WITH_LOCALS(_NumberOfReservedShares)
	{
		output.numberOfShares = 0;
	}

public:
	PUBLIC_FUNCTION(Fees)
	{
		output.issuanceFee = state.get().issuanceFee;
	}

	struct Orders_locals
	{
		Orders_output::Order order;
	};

	PUBLIC_FUNCTION_WITH_LOCALS(Orders)
	{
		output.orders.setAll(locals.order);
	}

	PUBLIC_PROCEDURE(Issue)
	{
		output.issuedNumberOfShares = input.numberOfShares;
	}

	PUBLIC_PROCEDURE(Transfer)
	{
		output.transferredNumberOfShares = input.numberOfShares;
	}

	REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
	{
		REGISTER_USER_FUNCTION(Fees, 1);
		REGISTER_USER_FUNCTION(Orders, 2);
		REGISTER_USER_PROCEDURE(Issue, 5);
		REGISTER_USER_PROCEDURE(Transfer, 2);
	}
};
