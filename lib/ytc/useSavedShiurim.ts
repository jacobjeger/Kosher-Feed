// YTC: reactive hook over lib/ytc/saved.ts. Returns the saved-id set
// + a toggle function. Re-renders on changes via the pub-sub.

import { useEffect, useState, useCallback } from "react";
import {
  getAllSavedIds, toggleSaved as toggle, onSavedShiurimChanged, hydrateSavedShiurim,
} from "@/lib/ytc/saved";

export function useSavedShiurim() {
  const [ids, setIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let mounted = true;
    getAllSavedIds().then((arr) => { if (mounted) setIds(new Set(arr)); });
    const off = onSavedShiurimChanged(() => {
      getAllSavedIds().then((arr) => { if (mounted) setIds(new Set(arr)); });
    });
    return () => { mounted = false; off(); };
  }, []);

  // Hydrate from Firebase once per mount. Cheap if already up to date.
  useEffect(() => { hydrateSavedShiurim(); }, []);

  const isSaved = useCallback((id: string) => ids.has(id), [ids]);
  const toggleSaved = useCallback(async (id: string) => { await toggle(id); }, []);

  return { savedIds: ids, isSaved, toggleSaved };
}
