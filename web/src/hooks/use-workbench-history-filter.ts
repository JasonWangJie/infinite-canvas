import { useMemo } from "react";
import { useWorkbenchHistoryFilterStore, type WorkbenchKind } from "@/stores/use-workbench-history-filter-store";

type SearchableLog = { title: string; prompt: string; model: string; status: string };

export function useWorkbenchHistoryFilter<T extends SearchableLog>(kind: WorkbenchKind, logs: T[]) {
    const filter = useWorkbenchHistoryFilterStore((state) => state[kind]);
    return useMemo(() => {
        const query = filter.query.trim().toLocaleLowerCase();
        return logs.filter((log) => (filter.status === "all" || log.status === filter.status) && (!query || [log.title, log.prompt, log.model].some((value) => value.toLocaleLowerCase().includes(query))));
    }, [logs, filter]);
}
