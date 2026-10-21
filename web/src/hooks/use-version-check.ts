import { useCallback, useMemo, useState } from "react";
import { APP_VERSION } from "@/constant/env";
import type { ReleaseInfo } from "@/lib/release";

// The managed fork is upgraded by its operator; opening the version dialog never contacts upstream.
export function useVersionCheck() {
    const [open, setOpen] = useState(false);
    const releases = useMemo<ReleaseInfo[]>(() => __APP_RELEASES__ || [], []);
    const openReleaseModal = useCallback(() => setOpen(true), []);
    const checkLatestRelease = useCallback(async (_showMessage = false) => true, []);
    return { open, setOpen, openReleaseModal, latestVersion: APP_VERSION, releases, checking: false, hasNewVersion: false, checkLatestRelease };
}
