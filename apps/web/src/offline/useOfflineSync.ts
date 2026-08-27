import { useCallback, useEffect, useState } from "react";
import { listOutbox, syncOutbox, type SyncResult } from "./pos-offline.js";

// Section 11: "Sync on reconnect." `navigator.onLine` plus the
// browser's online/offline events are the honest signal available to a
// web tab — no native connectivity APIs exist here. A false positive
// (wifi connected, no real internet) just means the first sync attempt
// fails with a network error and stays queued for the next trigger,
// which is the same safe behaviour as being genuinely offline.
export function useOfflineSync() {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSync, setLastSync] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);

  const refreshPendingCount = useCallback(async () => {
    setPendingCount((await listOutbox()).length);
  }, []);

  const runSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await syncOutbox();
      setLastSync(result);
      await refreshPendingCount();
      return result;
    } finally {
      setSyncing(false);
    }
  }, [refreshPendingCount]);

  useEffect(() => {
    refreshPendingCount();
    function onOnline() {
      setIsOnline(true);
      runSync();
    }
    function onOffline() {
      setIsOnline(false);
    }
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isOnline, pendingCount, lastSync, syncing, runSync, refreshPendingCount };
}
