import { useListPackingItems, useCreatePackingItem, useUpdatePackingItem, useDeletePackingItem, getListPackingItemsQueryKey, getGetTripSummaryQueryKey } from '@workspace/api-client-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Checkbox } from '@/components/ui/checkbox';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Briefcase, Plus, Trash2, ShieldAlert } from 'lucide-react';

const packingSchema = z.object({
  name: z.string().min(1, 'Item name is required'),
  category: z.string().optional(),
  required: z.boolean().default(false),
});

export function TripPackingList({ tripId, editMode }: { tripId: number, editMode?: boolean }) { // editMode retained for API compat but packing is now per-user
  const { data: items, isLoading } = useListPackingItems(tripId, { query: { enabled: !!tripId } });
  const queryClient = useQueryClient();
  const createItem = useCreatePackingItem();
  const updateItem = useUpdatePackingItem();
  const deleteItem = useDeletePackingItem();
  const [newItemName, setNewItemName] = useState('');

  if (isLoading) return <div>Loading...</div>;

  const handleToggle = (item: any) => {
    updateItem.mutate({ tripId, packingItemId: item.id, data: { checked: !item.checked } }, {
      onSuccess: () => {
        // Optimistic update would be better here, but invalidate is safer
        queryClient.invalidateQueries({ queryKey: getListPackingItemsQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetTripSummaryQueryKey(tripId) });
      }
    });
  };

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newItemName.trim()) return;
    
    createItem.mutate({ tripId, data: { name: newItemName, category: 'General', checked: false } }, {
      onSuccess: () => {
        setNewItemName('');
        queryClient.invalidateQueries({ queryKey: getListPackingItemsQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetTripSummaryQueryKey(tripId) });
      }
    });
  };

  const handleDelete = (id: number) => {
    deleteItem.mutate({ tripId, packingItemId: id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListPackingItemsQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetTripSummaryQueryKey(tripId) });
      }
    });
  };

  const categorized = items?.reduce((acc: any, item) => {
    const cat = item.category || 'General';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});

  const totalItems = items?.length || 0;
  const packedItems = items?.filter(i => i.checked).length || 0;
  const progress = totalItems === 0 ? 0 : Math.round((packedItems / totalItems) * 100);

  return (
    <div className="max-w-3xl space-y-8">
      <div className="bg-card border p-6 rounded-xl shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-serif font-bold text-lg">Packing Progress</h3>
          <span className="font-medium text-primary">{progress}% Packed</span>
        </div>
        <div className="h-3 w-full bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-primary transition-all duration-500 ease-out" style={{ width: `${progress}%` }} />
        </div>
        <p className="text-sm text-muted-foreground">{packedItems} of {totalItems} items packed</p>
      </div>

      <form onSubmit={handleAdd} className="flex gap-2">
        <Input 
          placeholder="Add a new item..." 
          value={newItemName}
          onChange={e => setNewItemName(e.target.value)}
          className="flex-1 bg-card"
        />
        <Button type="submit" disabled={createItem.isPending || !newItemName.trim()}>
          <Plus className="h-4 w-4 mr-2" /> Add
        </Button>
      </form>

      {(!items || items.length === 0) ? (
         <div className="text-center py-12 bg-muted/50 rounded-xl border border-dashed">
           <Briefcase className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
           <p className="text-lg font-medium">Packing list empty</p>
         </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(categorized || {}).map(([category, catItems]: [string, any]) => (
            <div key={category} className="space-y-3">
              <h4 className="font-semibold text-muted-foreground uppercase tracking-wider text-xs">{category}</h4>
              <div className="bg-card border rounded-xl overflow-hidden divide-y shadow-sm">
                {catItems.map((item: any) => (
                  <div key={item.id} className={`flex items-center justify-between p-4 transition-colors hover:bg-muted/50 ${item.checked ? 'bg-muted/20' : ''}`}>
                    <label className="flex items-center gap-3 cursor-pointer flex-1">
                      <Checkbox 
                        checked={item.checked} 
                        onCheckedChange={() => handleToggle(item)} 
                        className="h-5 w-5 data-[state=checked]:bg-primary data-[state=checked]:border-primary"
                      />
                      <span className={`text-base select-none transition-all ${item.checked ? 'line-through text-muted-foreground' : 'text-foreground font-medium'}`}>
                        {item.name}
                      </span>
                      {item.required && (
                        <ShieldAlert className="h-3.5 w-3.5 text-primary ml-2" />
                      )}
                    </label>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive shrink-0" onClick={() => handleDelete(item.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
