#pragma once

// Constant referenced by declarations below.
constexpr uint64 MAX_ORDERS = 4;

#define LEGACY_LIMIT 8

/** @brief Color values used by the fixture. */
enum Color : uint8
{
	Red,
	Green = 5,
	Blue,
};

enum class Mode : uint16
{
	Idle = 1,
	Busy = Idle + 1,
};

/** A plain nested-free struct. */
struct Point
{
	sint32 x;
	sint32 y;
};

#if 0
struct Hidden
{
	uint64 nope;
};
#endif

/** @brief Fixture contract with nested declarations. */
struct Container : public ContractBase
{
	/** @brief One order. */
	struct Order
	{
		id entity;
		sint64 price;
	};

	static constexpr uint64 LOCAL_LIMIT = 2 * MAX_ORDERS;

	using OrderArray = Array<Order, MAX_ORDERS>;

	/**
	 * @brief Input of DoThing.
	 * @note Exercises multi-declarators, arrays, and enum fields.
	 */
	struct DoThing_input
	{
		/** Number of units. */
		uint64 amount, count;
		Array<Order, MAX_ORDERS> orders;
		BitArray<64> flags;
		Color color;
		Mode mode;
		QPI::Asset asset;
	};

	struct DoThing_output
	{
		uint8 ok;
	};

	using DoThing_locals = NoData;

	typedef uint16 SmallIndex;

	/** @brief Does the thing. */
	PUBLIC_PROCEDURE_WITH_LOCALS(DoThing)
	{
		output.ok = 1;
	}

	struct Fire_input
	{
		uint64 value;
	};

	using Fire_output = NoData;

	PRIVATE_PROCEDURE(Fire)
	{
	}

	struct Notify_input
	{
		uint32 code;
	};

	using Notify_output = NoData;

	PRIVATE_PROCEDURE(Notify)
	{
	}

	REGISTER_USER_FUNCTIONS_AND_PROCEDURES()
	{
		REGISTER_USER_PROCEDURE(DoThing, LOCAL_LIMIT);
		REGISTER_USER_PROCEDURE(Fire, static_cast<uint16>(Mode::Busy));
		REGISTER_USER_PROCEDURE_NOTIFICATION(Notify);
	}
};
