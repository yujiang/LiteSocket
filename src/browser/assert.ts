export function strict(value: unknown, message = 'Assertion failed'): asserts value {
    if (!value) {
        const error = new Error(message);
        error.name = 'AssertionError';
        throw error;
    }
}
