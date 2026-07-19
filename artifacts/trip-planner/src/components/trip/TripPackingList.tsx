import { useListPackingItems, useCreatePackingItem, useUpdatePackingItem, useDeletePackingItem, getListPackingItemsQueryKey, getGetTripSummaryQueryKey } from '@workspace/api-client-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Briefcase, Plus, Trash2, ShieldAlert, Users, User } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';

export function TripPackingList({ tripId }: { tripId: number }) {
  const { isAdmin } = useAuth();
  const { data: items, isLoading } = useListPackingItems(tripId, { query: { enabled: !!tripId } });
  const queryClient = useQueryClient();
  const createItem = useCreatePackingItem();
  const updateItem = useUpdatePackingItem();
  const deleteItem = useDeletePackingItem();

  const [newTemplateName, setNewTemplateName] = useState('');
  const [newPersonalName, setNewPersonalName] = useState('');

  if (isLoading) return <div>Loading...</div>;

  const templateItems = (items as any[])?.filter((i: any) => i.isTemplate) ?? [];
  const personalItems = (items as any[])?.filter((i: any) => !i.isTemplate) ?? [];

  const allChecked = [...templateItems, ...personalItems].filter((i: any) => i.checked).length;
  const allTotal = [...templateItems, ...personalItems].length;
  const progress = allTotal === 0 ? 0 : Math.round((allChecked / allTotal) * 100);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListPackingItemsQueryKey(tripId) });
    queryClient.invalidateQueries({ queryKey: getGetTripSummaryQueryKey(tripId) });
  };

  const handleToggle = (item: any) => {
    updateItem.mutate({ tripId, packingItemId: item.id, data: { checked: !item.checked } }, {
      onSuccess: invalidate,
      onError: () => toast.error('Failed to update item'),
    });
  };

  const handleAddTemplate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTemplateName.trim()) return;
    (createItem as any).mutate({ tripId, data: { name: newTemplateName, category: 'General', checked: false, isTemplate: true } }, {
      onSuccess: () => { setNewTemplateName(''); invalidate(); },
      onError: () => toast.error('Failed to add item'),
    });
  };

  const handleAddPersonal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPersonalName.trim()) return;
    createItem.mutate({ tripId, data: { name: newPersonalName, category: 'General', checked: false } }, {
      onSuccess: () => { setNewPersonalName(''); invalidate(); },
      onError: () => toast.error('Failed to add item'),
    });
  };

  const handleDelete = (id: number) => {
    deleteItem.mutate({ tripId, packingItemId: id }, {
      onSuccess: invalidate,
      onError: () => toast.error('Failed to delete item'),
    });
  };

  const groupByCategory = (list: any[]) =>
    list.reduce((acc: Record<string, any[]>, item) => {
      const cat = item.category || 'General';
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(item);
      return acc;
    }, {});

  return (
    <div className="max-w-3xl space-y-8">

      {/* Progress */}
      <div className="bg-card border p-6 rounded-xl shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-serif font-bold text-lg">Packing Progress</h3>
          <span className="font-medium text-primary">{progress}% Packed</span>
        </div>
        <div className="h-3 w-full bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-sm text-muted-foreground">{allChecked} of {allTotal} items packed</p>
      </div>

      {/* ── Trip Packing List (template items) ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">Trip Packing List</h3>
          </div>
          <span className="text-xs text-muted-foreground">{templateItems.filter((i: any) => i.checked).length}/{templateItems.length} packed</span>
        </div>

        {isAdmin && (
          <form onSubmit={handleAddTemplate} className="flex gap-2">
            <Input
              placeholder="Add to everyone's list..."
              value={newTemplateName}
              onChange={e => setNewTemplateName(e.target.value)}
              className="flex-1 bg-card"
            />
            <Button type="submit" disabled={createItem.isPending || !newTemplateName.trim()} variant="outline">
              <Plus className="h-4 w-4 mr-2" /> Add to List
            </Button>
          </form>
        )}

        {templateItems.length === 0 ? (
          <div className="text-center py-8 bg-muted/50 rounded-xl border border-dashed">
            <Users className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">
              {isAdmin ? 'No shared items yet — add items above to give everyone a packing checklist.' : 'No shared packing items have been added yet.'}
            </p>
          </div>
        ) : (
          <PackingSection
            groups={groupByCategory(templateItems)}
            isAdmin={isAdmin}
            canDelete={isAdmin}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        )}
      </div>

      {/* ── My Personal Items ── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <User className="h-4 w-4 text-muted-foreground" />
            <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">My Items</h3>
          </div>
          <span className="text-xs text-muted-foreground">{personalItems.filter((i: any) => i.checked).length}/{personalItems.length} packed</span>
        </div>

        <form onSubmit={handleAddPersonal} className="flex gap-2">
          <Input
            placeholder="Add a personal item..."
            value={newPersonalName}
            onChange={e => setNewPersonalName(e.target.value)}
            className="flex-1 bg-card"
          />
          <Button type="submit" disabled={createItem.isPending || !newPersonalName.trim()}>
            <Plus className="h-4 w-4 mr-2" /> Add
          </Button>
        </form>

        {personalItems.length === 0 ? (
          <div className="text-center py-8 bg-muted/50 rounded-xl border border-dashed">
            <Briefcase className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-50" />
            <p className="text-sm text-muted-foreground">No personal items yet.</p>
          </div>
        ) : (
          <PackingSection
            groups={groupByCategory(personalItems)}
            isAdmin={isAdmin}
            canDelete={true}
            onToggle={handleToggle}
            onDelete={handleDelete}
          />
        )}
      </div>
    </div>
  );
}

function PackingSection({
  groups,
  isAdmin,
  canDelete,
  onToggle,
  onDelete,
}: {
  groups: Record<string, any[]>;
  isAdmin: boolean;
  canDelete: boolean;
  onToggle: (item: any) => void;
  onDelete: (id: number) => void;
}) {
  return (
    <div className="space-y-6">
      {Object.entries(groups).map(([category, catItems]) => (
        <div key={category} className="space-y-3">
          <h4 className="font-semibold text-muted-foreground uppercase tracking-wider text-xs">{category}</h4>
          <div className="bg-card border rounded-xl overflow-hidden divide-y shadow-sm">
            {catItems.map((item: any) => (
              <div
                key={item.id}
                className={`flex items-center justify-between p-4 transition-colors hover:bg-muted/50 ${item.checked ? 'bg-muted/20' : ''}`}
              >
                <label className="flex items-center gap-3 cursor-pointer flex-1">
                  <Checkbox
                    checked={item.checked}
                    onCheckedChange={() => onToggle(item)}
                    className="h-5 w-5 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                  />
                  <span className={`text-base select-none transition-all ${item.checked ? 'line-through text-muted-foreground' : 'text-foreground font-medium'}`}>
                    {item.name}
                  </span>
                  {item.required && (
                    <ShieldAlert className="h-3.5 w-3.5 text-primary ml-2" aria-label="Required" />
                  )}
                </label>
                {canDelete && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0"
                    onClick={() => onDelete(item.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
