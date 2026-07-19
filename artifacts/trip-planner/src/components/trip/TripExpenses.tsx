import { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { toast } from 'sonner';
import { format, parseISO } from 'date-fns';
import {
  Receipt, Plus, Trash2, Pencil, Utensils, Car, Plane,
  Hotel, Compass, DollarSign, TrendingUp, TrendingDown, Minus, Check,
  ArrowRight, Users, UserMinus,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
  DialogTrigger, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

const API_BASE = `${import.meta.env.BASE_URL}api`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Participant { id: number; name: string; }

type ExpenseCategory = 'travel' | 'activity' | 'restaurant' | 'car_rental' | 'accommodation' | 'other';

interface ExpenseSplit {
  id: number; expenseId: number; userId: number; userName: string;
  shareAmount: string; isPaid: boolean; paidAt: string | null;
}

interface TripExpense {
  id: number; tripId: number; paidByUserId: number; payerName: string;
  amount: string; currency: string; description: string;
  category: ExpenseCategory; date: string; notes: string | null;
  createdAt: string; splits: ExpenseSplit[];
}

interface BalanceEntry {
  userId: number; name: string; totalPaid: number; totalOwed: number; net: number;
  departed?: boolean;
}

interface Settlement {
  fromUserId: number; fromName: string; toUserId: number; toName: string; amount: number;
}

interface BalanceSummary {
  balances: BalanceEntry[]; settlements: Settlement[]; totalSpent: number; currency: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORY_META: Record<ExpenseCategory, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  travel:        { label: 'Travel',        icon: Plane,    color: 'text-blue-600',   bg: 'bg-blue-50' },
  activity:      { label: 'Activity',      icon: Compass,  color: 'text-green-600',  bg: 'bg-green-50' },
  restaurant:    { label: 'Restaurant',    icon: Utensils, color: 'text-orange-600', bg: 'bg-orange-50' },
  car_rental:    { label: 'Car Rental',    icon: Car,      color: 'text-purple-600', bg: 'bg-purple-50' },
  accommodation: { label: 'Accommodation', icon: Hotel,    color: 'text-amber-600',  bg: 'bg-amber-50' },
  other:         { label: 'Other',         icon: Receipt,  color: 'text-slate-600',  bg: 'bg-slate-50' },
};

// ── Expense form schema ───────────────────────────────────────────────────────

const expenseSchema = z.object({
  paidByUserId: z.coerce.number().int().positive(),
  amount: z
    .string()
    .min(1, 'Amount is required')
    .regex(/^\d+(\.\d{1,2})?$/, 'Enter a valid amount (e.g. 42.50)'),
  currency: z.string().default('USD'),
  description: z.string().min(1, 'Description is required'),
  category: z.enum(['travel', 'activity', 'restaurant', 'car_rental', 'accommodation', 'other']),
  date: z.string().min(1, 'Date is required'),
  notes: z.string().optional(),
});

type ExpenseFormValues = z.infer<typeof expenseSchema>;

// ── ExpenseForm ───────────────────────────────────────────────────────────────

function ExpenseForm({
  tripId, participants, expense, onSuccess,
}: {
  tripId: number; participants: Participant[]; expense?: TripExpense; onSuccess: () => void;
}) {
  const [isPending, setIsPending] = useState(false);

  const form = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseSchema),
    defaultValues: expense
      ? {
          paidByUserId: expense.paidByUserId,
          amount:       expense.amount,
          currency:     expense.currency,
          description:  expense.description,
          category:     expense.category,
          date:         expense.date,
          notes:        expense.notes ?? '',
        }
      : {
          paidByUserId: participants[0]?.id ?? 0,
          amount: '',
          currency: 'USD',
          description: '',
          category: 'other',
          date: new Date().toISOString().slice(0, 10),
          notes: '',
        },
  });

  const onSubmit = async (values: ExpenseFormValues) => {
    setIsPending(true);
    try {
      const url    = expense
        ? `${API_BASE}/trips/${tripId}/expenses/${expense.id}`
        : `${API_BASE}/trips/${tripId}/expenses`;
      const method = expense ? 'PATCH' : 'POST';
      const res = await fetch(url, {
        method,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, paidByUserId: Number(values.paidByUserId) }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
      toast.success(expense ? 'Expense updated' : 'Expense added');
      onSuccess();
    } catch (e: any) {
      toast.error(e.message ?? 'Failed to save expense');
    } finally {
      setIsPending(false);
    }
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">

        {/* Description */}
        <FormField control={form.control} name="description" render={({ field }) => (
          <FormItem>
            <FormLabel>Description</FormLabel>
            <FormControl>
              <Input placeholder="e.g. Dinner at La Terrasse…" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Amount + Currency */}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <FormField control={form.control} name="amount" render={({ field }) => (
              <FormItem>
                <FormLabel>Amount</FormLabel>
                <FormControl>
                  <Input type="text" inputMode="decimal" placeholder="0.00" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </div>
          <FormField control={form.control} name="currency" render={({ field }) => (
            <FormItem>
              <FormLabel>Currency</FormLabel>
              <FormControl>
                <Input placeholder="USD" maxLength={3} {...field} className="uppercase" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* Paid by + Category */}
        <div className="grid grid-cols-2 gap-3">
          <FormField control={form.control} name="paidByUserId" render={({ field }) => (
            <FormItem>
              <FormLabel>Paid by</FormLabel>
              <Select
                onValueChange={v => field.onChange(Number(v))}
                defaultValue={String(field.value)}
              >
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  {participants.map(p => (
                    <SelectItem key={p.id} value={String(p.id)}>{p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="category" render={({ field }) => (
            <FormItem>
              <FormLabel>Category</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  {(Object.entries(CATEGORY_META) as [ExpenseCategory, typeof CATEGORY_META[ExpenseCategory]][]).map(([v, m]) => (
                    <SelectItem key={v} value={v}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* Date */}
        <FormField control={form.control} name="date" render={({ field }) => (
          <FormItem>
            <FormLabel>Date</FormLabel>
            <FormControl><Input type="date" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Notes */}
        <FormField control={form.control} name="notes" render={({ field }) => (
          <FormItem>
            <FormLabel>Notes <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
            <FormControl>
              <Input placeholder="Any extra details…" {...field} value={field.value ?? ''} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {participants.length > 1 && (
          <p className="text-xs text-muted-foreground bg-muted/60 rounded-lg px-3 py-2">
            <Users className="h-3.5 w-3.5 inline mr-1" />
            Split equally among all {participants.length} travelers.
          </p>
        )}

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving…' : expense ? 'Update Expense' : 'Add Expense'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ── ExpenseCard ───────────────────────────────────────────────────────────────

function ExpenseCard({
  tripId, expense, participants, currentUserId, onChanged,
}: {
  tripId: number; expense: TripExpense; participants: Participant[];
  currentUserId?: number; onChanged: () => void;
}) {
  const [editOpen, setEditOpen]   = useState(false);
  const [reimbursing, setReimbursing] = useState<number | null>(null);

  const meta = CATEGORY_META[expense.category] ?? CATEGORY_META.other;
  const Icon = meta.icon;
  const firstSplit = expense.splits[0];
  const sharePerPerson = firstSplit ? parseFloat(firstSplit.shareAmount) : parseFloat(expense.amount);

  const handleDelete = async () => {
    if (!confirm(`Delete "${expense.description}"?`)) return;
    try {
      const res = await fetch(`${API_BASE}/trips/${tripId}/expenses/${expense.id}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error('Delete failed');
      toast.success('Expense deleted');
      onChanged();
    } catch {
      toast.error('Failed to delete expense');
    }
  };

  const handleReimburse = async (userId: number) => {
    setReimbursing(userId);
    try {
      const res = await fetch(
        `${API_BASE}/trips/${tripId}/expenses/${expense.id}/splits/${userId}/reimburse`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) throw new Error();
      toast.success('Marked as reimbursed');
      onChanged();
    } catch {
      toast.error('Failed to mark as reimbursed');
    } finally {
      setReimbursing(null);
    }
  };

  return (
    <div className="bg-card border rounded-xl shadow-sm overflow-hidden group hover:border-primary/50 transition-colors">
      {/* Category header */}
      <div className={`${meta.bg} px-4 py-3 flex items-center justify-between`}>
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-full bg-white/60">
            <Icon className={`h-4 w-4 ${meta.color}`} />
          </div>
          <span className={`text-xs font-semibold uppercase tracking-wide ${meta.color}`}>{meta.label}</span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7 hover:bg-white/60">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader><DialogTitle>Edit Expense</DialogTitle></DialogHeader>
              <ExpenseForm
                tripId={tripId} participants={participants} expense={expense}
                onSuccess={() => { setEditOpen(false); onChanged(); }}
              />
            </DialogContent>
          </Dialog>
          <Button
            variant="ghost" size="icon"
            className="h-7 w-7 hover:bg-white/60 text-destructive"
            onClick={handleDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="font-semibold text-base leading-snug">{expense.description}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Paid by <span className="font-medium text-foreground">{expense.payerName}</span>
              {' · '}
              {format(parseISO(expense.date), 'MMM d, yyyy')}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="text-xl font-bold">{expense.currency} {parseFloat(expense.amount).toFixed(2)}</p>
            <p className="text-xs text-muted-foreground">{expense.currency} {sharePerPerson.toFixed(2)} / person</p>
          </div>
        </div>

        {expense.notes && (
          <p className="text-xs text-muted-foreground border-t pt-2">{expense.notes}</p>
        )}

        {/* Splits list */}
        {expense.splits.length > 0 && (
          <div className="border-t pt-3 space-y-1.5">
            {expense.splits.map(split => {
              const canReimburse = !split.isPaid
                && split.userId !== expense.paidByUserId
                && (split.userId === currentUserId || currentUserId === expense.paidByUserId);

              return (
                <div key={split.id} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    {split.isPaid
                      ? <Check className="h-3.5 w-3.5 text-green-500 shrink-0" />
                      : <div className="h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/40 shrink-0" />
                    }
                    <span className={split.isPaid ? 'text-muted-foreground line-through' : ''}>
                      {split.userName}
                    </span>
                    {split.userId === expense.paidByUserId && (
                      <Badge variant="outline" className="text-[10px] py-0 h-4">Paid</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`font-medium tabular-nums ${split.isPaid ? 'text-muted-foreground' : ''}`}>
                      {expense.currency} {parseFloat(split.shareAmount).toFixed(2)}
                    </span>
                    {canReimburse && (
                      <Button
                        variant="outline" size="sm"
                        className="h-6 text-xs px-2"
                        disabled={reimbursing === split.userId}
                        onClick={() => handleReimburse(split.userId)}
                      >
                        {reimbursing === split.userId ? '…' : 'Mark Paid'}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── BalancePanel ──────────────────────────────────────────────────────────────

function BalancePanel({ tripId, refreshKey }: { tripId: number; refreshKey: number }) {
  const [balance, setBalance] = useState<BalanceSummary | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/trips/${tripId}/expenses/balance`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setBalance(d); })
      .catch(() => {});
  }, [tripId, refreshKey]);

  if (!balance) return <div className="py-10 text-center text-muted-foreground text-sm">Loading balances…</div>;

  const { balances, settlements, totalSpent, currency } = balance;

  return (
    <div className="space-y-6">
      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-card border rounded-xl p-4 text-center">
          <DollarSign className="h-5 w-5 text-primary mx-auto mb-1" />
          <p className="text-2xl font-bold">{currency} {totalSpent.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mt-0.5">Total Spent</p>
        </div>
        <div className="bg-card border rounded-xl p-4 text-center">
          <TrendingUp className="h-5 w-5 text-green-500 mx-auto mb-1" />
          <p className="text-2xl font-bold">{balances.filter(b => b.net > 0).length}</p>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mt-0.5">Being Owed</p>
        </div>
        <div className="bg-card border rounded-xl p-4 text-center">
          <TrendingDown className="h-5 w-5 text-red-500 mx-auto mb-1" />
          <p className="text-2xl font-bold">{balances.filter(b => b.net < 0).length}</p>
          <p className="text-xs text-muted-foreground uppercase tracking-wide mt-0.5">Owe Money</p>
        </div>
      </div>

      {/* Per-person balances */}
      {balances.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Net Balances</h3>
          <div className="bg-card border rounded-xl overflow-hidden divide-y">
            {balances.map(b => (
              <div key={b.userId} className={`flex items-center justify-between px-4 py-3 ${b.departed ? 'bg-amber-50 dark:bg-amber-950/20' : ''}`}>
                <div>
                  <p className="font-medium text-sm flex items-center gap-1.5">
                    {b.name}
                    {b.departed && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold uppercase tracking-wide bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800 rounded-full px-1.5 py-0.5">
                        <UserMinus className="h-2.5 w-2.5" />
                        Departed
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Paid {currency} {b.totalPaid.toFixed(2)} · Owes {currency} {b.totalOwed.toFixed(2)}
                    {b.departed && ' · No longer on this trip'}
                  </p>
                </div>
                <div className={`flex items-center gap-1.5 font-semibold tabular-nums ${
                  b.net > 0 ? 'text-green-600' : b.net < 0 ? 'text-red-600' : 'text-muted-foreground'
                }`}>
                  {b.net > 0
                    ? <TrendingUp className="h-4 w-4" />
                    : b.net < 0
                      ? <TrendingDown className="h-4 w-4" />
                      : <Minus className="h-4 w-4" />
                  }
                  {b.net >= 0 ? '+' : ''}{currency} {b.net.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Settlements */}
      {settlements.length > 0 ? (
        <div>
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">Who Pays Whom</h3>
          <div className="space-y-2">
            {settlements.map((s, i) => (
              <div key={i} className="bg-card border rounded-xl px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">{s.fromName}</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground shrink-0" />
                  <span className="font-medium">{s.toName}</span>
                </div>
                <span className="font-semibold text-primary tabular-nums">
                  {currency} {s.amount.toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : balances.length > 0 ? (
        <div className="text-center py-6 bg-green-50 dark:bg-green-950/20 rounded-xl border border-green-200 dark:border-green-900">
          <Check className="h-8 w-8 text-green-500 mx-auto mb-2" />
          <p className="font-medium text-green-700 dark:text-green-400">All settled up!</p>
          <p className="text-sm text-muted-foreground mt-0.5">No outstanding balances.</p>
        </div>
      ) : null}
    </div>
  );
}

// ── TripExpenses (main) ───────────────────────────────────────────────────────

export function TripExpenses({
  tripId,
  participants,
  currentUserId,
}: {
  tripId: number;
  participants: Participant[];
  currentUserId?: number;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<'expenses' | 'balance'>('expenses');
  const [refreshKey, setRefreshKey] = useState(0);
  const [expenses, setExpenses] = useState<TripExpense[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadExpenses = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/trips/${tripId}/expenses`, { credentials: 'include' });
      if (res.ok) setExpenses(await res.json());
    } catch {
      setExpenses([]);
    } finally {
      setIsLoading(false);
    }
  }, [tripId]);

  useEffect(() => { loadExpenses(); }, [loadExpenses]);

  const handleChanged = useCallback(() => {
    loadExpenses();
    setRefreshKey(k => k + 1);
  }, [loadExpenses]);

  const tabCls = (active: boolean) =>
    `px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
      active
        ? 'bg-background shadow text-foreground'
        : 'text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div className="space-y-6">
      {/* Top bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 bg-muted rounded-lg p-1">
          <button
            onClick={() => setActiveSection('expenses')}
            className={tabCls(activeSection === 'expenses')}
          >
            Expenses
            {expenses && expenses.length > 0 && (
              <span className="ml-1.5 bg-primary/10 text-primary text-xs rounded-full px-1.5">
                {expenses.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveSection('balance')}
            className={tabCls(activeSection === 'balance')}
          >
            Balance
          </button>
        </div>

        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button disabled={participants.length === 0}>
              <Plus className="h-4 w-4 mr-2" /> Add Expense
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Add Expense</DialogTitle>
              <DialogDescription>
                Split equally among all {participants.length} traveler
                {participants.length !== 1 ? 's' : ''}.
              </DialogDescription>
            </DialogHeader>
            <ExpenseForm
              tripId={tripId}
              participants={participants}
              onSuccess={() => { setAddOpen(false); handleChanged(); }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {/* Expenses list */}
      {activeSection === 'expenses' && (
        isLoading ? (
          <div className="py-20 text-center text-muted-foreground">Loading expenses…</div>
        ) : !expenses || expenses.length === 0 ? (
          <div className="text-center py-16 bg-muted/50 rounded-xl border border-dashed">
            <Receipt className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">No expenses yet</p>
            <p className="text-muted-foreground text-sm mt-1">
              Add an expense and it'll be split equally among all travelers.
            </p>
          </div>
        ) : (
          <div className="grid md:grid-cols-2 gap-4">
            {expenses.map(expense => (
              <ExpenseCard
                key={expense.id}
                tripId={tripId}
                expense={expense}
                participants={participants}
                currentUserId={currentUserId}
                onChanged={handleChanged}
              />
            ))}
          </div>
        )
      )}

      {/* Balance section */}
      {activeSection === 'balance' && (
        !expenses || expenses.length === 0 ? (
          <div className="text-center py-16 bg-muted/50 rounded-xl border border-dashed">
            <DollarSign className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">No expenses to balance</p>
            <p className="text-muted-foreground text-sm mt-1">Add some expenses first.</p>
          </div>
        ) : (
          <BalancePanel tripId={tripId} refreshKey={refreshKey} />
        )
      )}
    </div>
  );
}
