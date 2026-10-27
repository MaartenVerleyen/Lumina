import { useLibraryCore } from "./library/core";
import { usePreferences } from "./library/usePreferences";
import { useFilterState } from "./library/useFilterState";
import { useNaturalSearch } from "./library/useNaturalSearch";
import { useFolder } from "./library/useFolder";
import { useCollections } from "./library/useCollections";
import { useSmartSearch } from "./library/useSmartSearch";
import { useLibraryView } from "./library/useLibraryView";
import { useTriage } from "./library/useTriage";
import { useStaging } from "./library/useStaging";
import { useLocation } from "./library/useLocation";
import { usePeople } from "./library/usePeople";
import { useAi } from "./library/useAi";
import { useExport } from "./library/useExport";
import { useHealth } from "./library/useHealth";
import { useImport } from "./library/useImport";
import { useHighlights } from "./library/useHighlights";
import { useBackup } from "./library/useBackup";

export type { Toast } from "./library/shared";

// Everything the app knows about the open library, as one object (`lib`) for the components.
// Each area lives in its own hook under ./library; they share the core state (folder, photos, selection,
// notifications, undo) and are called in dependency order.
export function useLibraryState() {
  const core = useLibraryCore();
  const preferences = usePreferences(core);
  const typedFilters = useFilterState();
  // What the search box means, plain words included, for everything that filters or searches
  const filters = { ...typedFilters, ...useNaturalSearch(core, typedFilters) };
  const folder = useFolder(core, filters);
  const collections = useCollections(core, filters);
  const smart = useSmartSearch(core, filters, folder.progress !== null);
  const view = useLibraryView(core, filters, collections, smart);
  const triage = useTriage(core, view);
  const staging = useStaging(core, filters, view);
  const location = useLocation(core);
  const people = usePeople(core, filters);
  const ai = useAi(core);
  const exporter = useExport(core);
  const health = useHealth(core);
  const importer = useImport(core, filters, folder);
  const highlighter = useHighlights(core, filters, view, collections);
  const backup = useBackup(core, folder.recentFolders);

  return {
    ...core,
    ...preferences,
    ...filters,
    ...folder,
    ...collections,
    ...smart,
    ...view,
    ...triage,
    ...staging,
    ...location,
    ...people,
    ...ai,
    ...exporter,
    ...health,
    ...importer,
    ...highlighter,
    ...backup,
    canUndo: core.undo.canUndo,
    canRedo: core.undo.canRedo,
    handleUndo: core.undo.handleUndo,
    handleRedo: core.undo.handleRedo,
  };
}

export type LibraryState = ReturnType<typeof useLibraryState>;
