"""Sort selected invoice rows by amount, largest first."""


def run(params: dict, inputs: dict) -> dict:
    amount_column = params["amount_column"]
    return {
        "rows": sorted(
            inputs["rows"],
            key=lambda row: row[amount_column],
            reverse=bool(params["sort_descending"]),
        )
    }
