import { memo, useMemo } from "react";
import { FolderTreeNode, MediaFilter, PhotoItem, SmartFilter } from "../../types/lumina";
import {
  BrainCircuit,
  Camera,
  ImageIcon,
  ChevronDown,
  ChevronRight,
  EyeOff,
  Focus,
  FileText,
  Film,
  Flag,
  Folder,
  Layers,
  MapPin,
  Package,
  Pin,
  Smartphone,
  MessageCircle,
  Sparkles,
  Star,
  Trash2,
  XCircle,
} from "lucide-react";

interface LeftSidebarProps {
  leftWidth: number;
  photos: PhotoItem[];
  smartFilter: SmartFilter;
  setSmartFilter: React.Dispatch<React.SetStateAction<SmartFilter>>;
  hasPeopleFilter: boolean;
  clearPeopleFilter: () => void;
  activeSubfolder: string;
  setActiveSubfolder: React.Dispatch<React.SetStateAction<string>>;
  activeEvent: string;
  setActiveEvent: React.Dispatch<React.SetStateAction<string>>;
  setActiveTag: React.Dispatch<React.SetStateAction<string>>;
  picksCount: number;
  basketCount: number;
  rejectsCount: number;
  screenshotPhotosCount: number;
  whatsappPhotosCount: number;
  totalBurstGroups: number;
  duplicatePhotosCount: number;
  gpsPhotosCount: number;
  stagedPhotosCount: number;
  eyesClosedCount: number;
  softFocusCount: number;
  videosCount: number;
  mediaFilter: MediaFilter;
  setMediaFilter: (f: MediaFilter) => void;
  stillsCount: number;
  shownCount: number;
  folderTree: { rootCount: number; nodes: FolderTreeNode[] };
  expandedFolders: Set<string>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
  // Optional props for Simple Mode & Empty Trash / Context Menu
  simpleMode?: boolean;
  handleEmptyTrashToRecycleBin?: () => Promise<void>;
  onFolderContextMenu?: (folderRelPath: string, e: React.MouseEvent) => void;
  // Collapsed section ids ("filters", "folders"), remembered with the layout
  collapsedSections: string[];
  onToggleSection: (id: string) => void;
}

// Quick filters that accept dropped photos: Picks flags them, Basket pins them, Rejects rejects + stages them
const DROP_FILTERS: Record<string, Record<string, string>> = {
  PICKS: { "data-drop-kind": "pick", "data-drop-label": "Flag as pick" },
  BASKET: { "data-drop-kind": "basket", "data-drop-label": "Pin to Basket" },
  REJECTS: { "data-drop-kind": "trash", "data-drop-label": "Reject & stage for _Trash" },
};

function LeftSidebar({
  leftWidth,
  photos,
  smartFilter,
  setSmartFilter,
  hasPeopleFilter,
  clearPeopleFilter,
  activeSubfolder,
  setActiveSubfolder,
  activeEvent,
  setActiveEvent,
  setActiveTag,
  picksCount,
  basketCount,
  rejectsCount,
  screenshotPhotosCount,
  whatsappPhotosCount,
  totalBurstGroups,
  duplicatePhotosCount,
  gpsPhotosCount,
  stagedPhotosCount,
  eyesClosedCount,
  softFocusCount,
  videosCount,
  mediaFilter,
  setMediaFilter,
  stillsCount,
  shownCount,
  folderTree,
  expandedFolders,
  setExpandedFolders,
  simpleMode = false,
  handleEmptyTrashToRecycleBin,
  onFolderContextMenu,
  collapsedSections,
  onToggleSection,
}: LeftSidebarProps) {
  // Section header that collapses its section (state kept by the caller)
  const sectionHeader = (id: string, label: string, extra?: React.ReactNode) => {
    const collapsed = collapsedSections.includes(id);
    return (
      <div className="flex items-center justify-between">
        <button
          onClick={() => onToggleSection(id)}
          aria-expanded={!collapsed}
          className="flex items-center gap-1 text-xs font-medium text-zinc-500 hover:text-zinc-300"
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          {label}
        </button>
        {extra}
      </div>
    );
  };

  function toggleFolderExpand(fullPath: string, e: React.MouseEvent) {
    e.stopPropagation();
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(fullPath)) next.delete(fullPath);
      else next.add(fullPath);
      return next;
    });
  }

  function renderFolderTreeNodes(nodes: FolderTreeNode[], depth = 0) {
    return nodes.map((node) => {
      const hasChildren = node.children.length > 0;
      const isExpanded = expandedFolders.has(node.fullPath);
      const isSelected = activeSubfolder === node.fullPath;

      return (
        <div key={node.fullPath} className="flex flex-col">
          <div
            data-folder-path={node.fullPath}
            // Photos dropped here are staged to move into this folder
            data-drop-kind="folder"
            data-drop-value={node.fullPath.replace(/ \/ /g, "/")}
            data-drop-label={`Move to ${node.fullPath}`}
            onClick={() => {
              setActiveSubfolder(isSelected ? "ALL" : node.fullPath);
              if (hasChildren && !isExpanded) {
                setExpandedFolders((prev) => new Set(prev).add(node.fullPath));
              }
            }}
            onContextMenu={(e) => {
              if (onFolderContextMenu) {
                e.preventDefault();
                e.stopPropagation();
                onFolderContextMenu(node.fullPath, e);
              }
            }}
            style={{ paddingLeft: `${depth * 14 + 8}px` }}
            className={`group flex items-center justify-between pr-2.5 py-1.5 rounded-md text-xs cursor-pointer transition ${
              isSelected
                ? "bg-emerald-500/15 text-emerald-300 font-medium border border-emerald-500/30"
                : "text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200 border border-transparent"
            }`}
            title="Left-click to filter • Right-click for folder options"
          >
            <div className="flex items-center gap-1.5 truncate">
              {hasChildren ? (
                <button
                  onClick={(e) => toggleFolderExpand(node.fullPath, e)}
                  className="p-0.5 hover:bg-zinc-700/60 rounded text-zinc-400 hover:text-white"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5" />
                  )}
                </button>
              ) : (
                <span className="w-4" />
              )}
              <Folder
                className={`w-3.5 h-3.5 shrink-0 ${
                  isSelected ? "text-emerald-400" : "text-zinc-500 group-hover:text-zinc-300"
                }`}
              />
              <span className="truncate">{node.name}</span>
            </div>
            <span className="text-[11px] text-zinc-500 font-mono ml-1.5 shrink-0">
              {node.totalCount}
            </span>
          </div>

          {hasChildren && isExpanded && (
            <div className="flex flex-col border-l border-zinc-800/60 ml-3">
              {renderFolderTreeNodes(node.children, depth + 1)}
            </div>
          )}
        </div>
      );
    });
  }

  const {
    trashFolderCount,
    favoritesCount,
    aiTaggedCount,
    untaggedCount,
    ocrCount,
  } = useMemo(() => {
    let trash = 0;
    let favs = 0;
    let aiTagged = 0;
    let untagged = 0;
    let ocr = 0;
    for (let i = 0; i < photos.length; i++) {
      const p = photos[i];
      if (p.subfolder === "_Trash" || p.staged_target === "_Trash") trash++;
      if (p.rating >= 4) favs++;
      if (p.tags.length > 0 || p.ai_caption.length > 0) aiTagged++;
      else untagged++;
      if (p.ocr_text) ocr++;
    }
    return {
      trashFolderCount: trash,
      favoritesCount: favs,
      aiTaggedCount: aiTagged,
      untaggedCount: untagged,
      ocrCount: ocr,
    };
  }, [photos]);

  const filterItems = [
    {
      id: "ALL",
      label: videosCount > 0 ? "All" : "All photos",
      count: shownCount,
      icon: <Camera className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    ...(videosCount > 0
      ? [
          {
            id: "PHOTOS",
            label: "Photos",
            count: stillsCount,
            icon: <ImageIcon className="w-3.5 h-3.5" />,
            hideInSimple: false,
          },
          {
            id: "VIDEOS",
            label: "Videos",
            count: videosCount,
            icon: <Film className="w-3.5 h-3.5" />,
            hideInSimple: false,
          },
        ]
      : []),
    {
      id: "PICKS",
      label: simpleMode ? "Kept photos (P)" : "Picks (P)",
      count: picksCount,
      icon: <Flag className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    {
      id: "BASKET",
      label: simpleMode ? "Saved to pinboard" : "Pinboard basket (B)",
      count: basketCount,
      icon: <Pin className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    {
      id: "REJECTS",
      label: simpleMode ? "To delete (X)" : "Rejects (X)",
      count: rejectsCount,
      icon: <XCircle className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    {
      id: "FAVORITES",
      label: "Favorites (4★+)",
      count: favoritesCount,
      icon: <Star className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    {
      id: "AI_TAGGED",
      label: "AI tagged",
      count: aiTaggedCount,
      icon: <BrainCircuit className="w-3.5 h-3.5" />,
      hideInSimple: true,
    },
    {
      id: "UNTAGGED",
      label: "Untagged",
      count: untaggedCount,
      icon: <Sparkles className="w-3.5 h-3.5" />,
      hideInSimple: true,
    },
    {
      id: "SCREENSHOTS",
      label: "Screenshots",
      count: screenshotPhotosCount,
      icon: <Smartphone className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    {
      id: "WHATSAPP",
      label: "WhatsApp",
      count: whatsappPhotosCount,
      icon: <MessageCircle className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    {
      id: "DUPLICATES",
      label: simpleMode
        ? `Similar shots (${totalBurstGroups})`
        : `Burst groups (${totalBurstGroups})`,
      count: duplicatePhotosCount,
      icon: <Layers className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    {
      id: "HAS_OCR",
      label: simpleMode ? "Photos with text" : "Has text",
      count: ocrCount,
      icon: <FileText className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    {
      id: "HAS_GPS",
      label: simpleMode ? "Photos on the map" : "Has a location",
      count: gpsPhotosCount,
      icon: <MapPin className="w-3.5 h-3.5" />,
      hideInSimple: false,
    },
    ...(eyesClosedCount > 0
      ? [
          {
            id: "EYES_CLOSED",
            label: "Eyes closed",
            count: eyesClosedCount,
            icon: <EyeOff className="w-3.5 h-3.5" />,
            hideInSimple: false,
          },
        ]
      : []),
    ...(softFocusCount > 0
      ? [
          {
            id: "SOFT_FOCUS",
            label: "Out of focus",
            count: softFocusCount,
            icon: <Focus className="w-3.5 h-3.5" />,
            hideInSimple: false,
          },
        ]
      : []),
    ...(stagedPhotosCount > 0
      ? [
          {
            id: "STAGED",
            label: simpleMode ? "Pending folder moves" : "Staged moves",
            count: stagedPhotosCount,
            icon: <Package className="w-3.5 h-3.5" />,
            hideInSimple: false,
          },
        ]
      : []),
  ].filter((it) => !(simpleMode && it.hideInSimple));

  return (
    <aside
      style={{ width: `${leftWidth}px` }}
      className="bg-panel flex flex-col p-3 gap-5 overflow-y-auto shrink-0"
    >
      <div>
        {sectionHeader("filters", simpleMode ? "Quick filters" : "Culling & triage")}
        {!collapsedSections.includes("filters") && (
        <div className="mt-2 flex flex-col gap-0.5 text-xs">
          {filterItems.map((item) => {
            // Photos and Videos set the media filter (also in the toolbar on every photo tab); All clears both
            const isMedia = item.id === "PHOTOS" || item.id === "VIDEOS";
            const isSelected =
              (isMedia ? smartFilter === "ALL" && mediaFilter === item.id : smartFilter === item.id) &&
              (item.id !== "ALL" || mediaFilter === "ALL") &&
              !hasPeopleFilter &&
              activeSubfolder === "ALL" &&
              activeEvent === "ALL";
            return (
              <button
                key={item.id}
                {...(DROP_FILTERS[item.id] ?? {})}
                onClick={() => {
                  if (isMedia) {
                    setSmartFilter("ALL");
                    setMediaFilter(item.id as MediaFilter);
                  } else {
                    setSmartFilter(item.id as SmartFilter);
                    if (item.id === "ALL") setMediaFilter("ALL");
                  }
                  clearPeopleFilter();
                  setActiveSubfolder("ALL");
                  setActiveEvent("ALL");
                  setActiveTag("ALL");
                }}
                className={`flex justify-between items-center px-2.5 py-1.5 rounded-md border transition ${
                  isSelected
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30 font-medium"
                    : "text-zinc-400 hover:bg-zinc-900/60 hover:text-zinc-200 border-transparent"
                }`}
              >
                <span className="flex items-center gap-2 truncate">
                  {/* Grey, and the accent only on the filter that is on */}
                  <span className={`flex ${isSelected ? "text-emerald-400" : "text-zinc-500"}`}>{item.icon}</span>
                  <FilterLabel label={item.label} />
                </span>
                <span className="text-[11px] text-zinc-500 font-mono ml-1.5">{item.count}</span>
              </button>
            );
          })}
        </div>
        )}

        {/* 1-Click Empty _Trash to OS Recycle Bin */}
        {trashFolderCount > 0 && handleEmptyTrashToRecycleBin && (
          <button
            onClick={handleEmptyTrashToRecycleBin}
            className="mt-2.5 w-full px-2.5 py-1.5 bg-red-950/40 hover:bg-red-900/60 border border-red-800/50 text-red-300 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 transition"
            title="Safely move all _Trash photos to your Windows/Linux Recycle Bin"
          >
            <Trash2 className="w-3.5 h-3.5 text-red-400" />
            <span>Empty _Trash to Recycle Bin ({trashFolderCount})</span>
          </button>
        )}
      </div>

      {/* Hierarchical Folder Tree */}
      {photos.length > 0 && (
        <div>
          {sectionHeader(
            "folders",
            "Folders",
            activeSubfolder !== "ALL" ? (
              <button
                onClick={() => setActiveSubfolder("ALL")}
                className="text-[11px] text-emerald-400 hover:underline"
              >
                Reset
              </button>
            ) : undefined
          )}

          {!collapsedSections.includes("folders") && (
          <div className="mt-2 flex flex-col gap-0.5">
            {folderTree.rootCount > 0 && (
              <div
                data-folder-path="Root"
                onClick={() =>
                  setActiveSubfolder(activeSubfolder === "Root" ? "ALL" : "Root")
                }
                onContextMenu={(e) => {
                  if (onFolderContextMenu) {
                    e.preventDefault();
                    e.stopPropagation();
                    onFolderContextMenu("Root", e);
                  }
                }}
                className={`flex items-center justify-between px-2.5 py-1.5 rounded-md text-xs cursor-pointer border transition ${
                  activeSubfolder === "Root"
                    ? "bg-emerald-500/15 text-emerald-300 font-medium border-emerald-500/30"
                    : "text-zinc-400 hover:bg-zinc-900/70 hover:text-zinc-200 border-transparent"
                }`}
                title="Left-click to filter • Right-click for folder options"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <span className="w-4" />
                  <Folder
                    className={`w-3.5 h-3.5 shrink-0 ${
                      activeSubfolder === "Root" ? "text-emerald-400" : "text-zinc-500"
                    }`}
                  />
                  <span>Root (Top Level)</span>
                </div>
                <span className="text-[11px] text-zinc-500 font-mono">{folderTree.rootCount}</span>
              </div>
            )}
            {renderFolderTreeNodes(folderTree.nodes, 0)}
          </div>
          )}
        </div>
      )}

    </aside>
  );
}

export default memo(LeftSidebar);

// "Picks (P)": the name, and its shortcut as a small keycap
function FilterLabel({ label }: { label: string }) {
  const m = label.match(/^(.*) \(([A-Z])\)$/);
  if (!m) return <span className="truncate">{label}</span>;
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      <span className="truncate">{m[1]}</span>
      <kbd className="px-1 rounded border border-zinc-700 text-[11px] leading-[14px] font-mono text-zinc-500">{m[2]}</kbd>
    </span>
  );
}
