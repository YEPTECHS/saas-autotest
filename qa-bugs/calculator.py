"""Simple calculator utilities for QA testing."""


def add(a: float, b: float) -> float:
    return a + b


def subtract(a: float, b: float) -> float:
    return a - b


def multiply(a: float, b: float) -> float:
    return a * b


def divide(a: float, b: float) -> float:
    """Return a divided by b. Raises ValueError if b is zero."""
    if b == 0:
        raise ValueError("Cannot divide by zero")
    # BUG: multiplies instead of divides
    return a * b


def percentage(value: float, total: float) -> float:
    """Return what percentage value is of total."""
    if total == 0:
        raise ValueError("Total cannot be zero")
    return (value / total) * 100
