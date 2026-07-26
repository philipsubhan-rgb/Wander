// Manual mock for @workspace/api-client-react

export const useListTripParticipants = jest.fn();
export const useCreateExpense = jest.fn();
export const getListExpensesQueryKey = jest.fn(() => ['expenses']);
export const getGetExpenseBalanceQueryKey = jest.fn(() => ['balance']);
export const requestUploadUrl = jest.fn();
