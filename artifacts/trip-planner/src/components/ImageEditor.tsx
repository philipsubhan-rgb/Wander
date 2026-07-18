import { useState, useEffect, useRef } from 'react';
import { Camera, Search, Link, Trash2, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

interface WikiResult {
  title: string;
  url: string;
}

async function searchWikiImages(query: string): Promise<WikiResult[]> {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: query,
    gsrlimit: '18',
    prop: 'pageimages',
    pithumbsize: '500',
    pilimit: '18',
    format: 'json',
    origin: '*',
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`);
  if (!res.ok) return [];
  const data = await res.json();
  const pages = Object.values(data.query?.pages ?? {}) as any[];
  return pages
    .filter(p => p.thumbnail?.source)
    .map(p => ({ title: p.title, url: p.thumbnail.source }));
}

// ── Tab button ────────────────────────────────────────────────────────────────

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 text-sm font-medium transition-colors rounded-t-md border-b-2 ${
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export interface ImageEditorProps {
  /** Hint used for the default search query when the dialog opens */
  searchHint: string;
  /** Called with the chosen URL, or null to remove the image */
  onSave: (url: string | null) => void;
  /** Extra classes for the trigger button */
  className?: string;
  /** Size variant */
  size?: 'sm' | 'xs';
}

export function ImageEditor({ searchHint, onSave, className = '', size = 'sm' }: ImageEditorProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'search' | 'url'>('search');

  // Search tab state
  const [query, setQuery] = useState(searchHint);
  const [results, setResults] = useState<WikiResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // URL tab state
  const [pasteUrl, setPasteUrl] = useState('');
  const [previewOk, setPreviewOk] = useState(true);

  const didAutoSearch = useRef(false);

  // Auto-search when dialog first opens
  useEffect(() => {
    if (!open) {
      didAutoSearch.current = false;
      return;
    }
    if (didAutoSearch.current) return;
    didAutoSearch.current = true;
    setQuery(searchHint);
    setSelected(null);
    setPasteUrl('');
    setPreviewOk(true);
    doSearch(searchHint);
  }, [open, searchHint]);

  const doSearch = async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setResults([]);
    const imgs = await searchWikiImages(q);
    setResults(imgs);
    setSearching(false);
  };

  const handleSave = () => {
    const url = tab === 'url' ? pasteUrl.trim() || null : selected;
    onSave(url);
    setOpen(false);
  };

  const canSave = tab === 'url' ? !!pasteUrl.trim() : !!selected;

  const btnSize = size === 'xs' ? 'h-7 w-7' : 'h-8 w-8';
  const iconSize = size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          className={`${btnSize} bg-white/90 hover:bg-white text-foreground shadow ${className}`}
          title="Change image"
        >
          <Camera className={iconSize} />
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-3 border-b">
          <DialogTitle>Edit Image</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 px-5 pt-2 border-b">
          <Tab active={tab === 'search'} onClick={() => setTab('search')}>
            <span className="flex items-center gap-1.5"><Search className="h-3.5 w-3.5" />Search Wikipedia</span>
          </Tab>
          <Tab active={tab === 'url'} onClick={() => setTab('url')}>
            <span className="flex items-center gap-1.5"><Link className="h-3.5 w-3.5" />Paste URL</span>
          </Tab>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

          {/* ── Search tab ── */}
          {tab === 'search' && (
            <>
              <div className="flex gap-2">
                <Input
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') doSearch(query); }}
                  placeholder="Search for images…"
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  onClick={() => doSearch(query)}
                  disabled={searching}
                  className="shrink-0"
                >
                  {searching ? <span className="animate-spin">⟳</span> : <Search className="h-4 w-4" />}
                </Button>
              </div>

              {searching && (
                <div className="text-center py-8 text-sm text-muted-foreground">Searching…</div>
              )}

              {!searching && results.length === 0 && (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No images found. Try a different search term.
                </div>
              )}

              {results.length > 0 && (
                <div className="grid grid-cols-3 gap-2">
                  {results.map(r => (
                    <button
                      key={r.url}
                      type="button"
                      onClick={() => setSelected(prev => prev === r.url ? null : r.url)}
                      className={`relative aspect-video rounded-lg overflow-hidden border-2 transition-all ${
                        selected === r.url
                          ? 'border-primary ring-2 ring-primary/30 scale-[0.98]'
                          : 'border-transparent hover:border-muted-foreground/40'
                      }`}
                      title={r.title}
                    >
                      <img src={r.url} alt={r.title} className="h-full w-full object-cover" />
                      {selected === r.url && (
                        <div className="absolute inset-0 bg-primary/20 flex items-center justify-center">
                          <div className="bg-primary rounded-full p-1">
                            <Check className="h-4 w-4 text-primary-foreground" />
                          </div>
                        </div>
                      )}
                      <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/60 to-transparent px-1.5 py-1">
                        <p className="text-white text-[10px] leading-tight truncate">{r.title}</p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── URL tab ── */}
          {tab === 'url' && (
            <div className="space-y-3">
              <Input
                value={pasteUrl}
                onChange={e => { setPasteUrl(e.target.value); setPreviewOk(true); }}
                placeholder="https://example.com/image.jpg"
                type="url"
              />
              {pasteUrl && previewOk && (
                <div className="rounded-xl overflow-hidden border aspect-video bg-muted">
                  <img
                    src={pasteUrl}
                    alt="Preview"
                    className="h-full w-full object-cover"
                    onError={() => setPreviewOk(false)}
                  />
                </div>
              )}
              {pasteUrl && !previewOk && (
                <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive text-center">
                  Couldn't load that URL. Make sure it's a direct image link.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t flex items-center justify-between gap-3 bg-muted/30">
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={() => { onSave(null); setOpen(false); }}
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            Remove image
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={!canSave} onClick={handleSave}>Use this image</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
