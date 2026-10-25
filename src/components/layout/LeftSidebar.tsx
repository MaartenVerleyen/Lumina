import { memo, useMemo } from "react";
import { FolderTreeNode, PhotoItem, SmartFilter } from "../../types/lumina";
import {
  BrainCircuit,
  Calendar,
  Camera,
  ChevronDown,
  ChevronRight,
  FileText,
  Flag,
  Folder,
  Layers,
  MapPin,
  Package,
  Pin,
  Smartphone,
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
  selectedPerson: string | null;
  setSelectedPerson: React.Dispatch<React.SetStateAction<string | null>>;
  activeSubfolder: string;
  setActiveSubfolder: React.Dispatch<React.SetStateAction<string>>;
  activeEvent: string;
  setActiveEvent: React.Dispatch<React.SetStateAction<string>>;
  activeTag: string;
  setActiveTag: React.Dispatch<React.SetStateAction<string>>;
  picksCount: number;
  basketCount: number;
  rejectsCount: number;
  screenshotPhotosCount: number;
  totalBurstGroups: number;
  duplicatePhotosCount: number;
  gpsPhotosCount: number;
  stagedPhotosCount: number;
  folderTree: { rootCount: number; nodes: FolderTreeNode[] };
  expandedFolders: Set<string>;
  setExpandedFolders: React.Dispatch<React.SetStateAction<Set<string>>>;
  autoEvents: [string, number][];
  allLibraryTags: string[];
  // Optional props for Simple Mode & Empty Trash / Context Menu
  simpleMode?: boolean;
  handleEmptyTrashToRecycleBin?: () => Promise<void>;
  onFolderContextMenu?: (folderRelPath: string, e: React.MouseEvent) => void;
}

function LeftSidebar({
  leftWidth,
  photos,
  smartFilter,
  setSmartFilter,
  selectedPerson,
  setSelectedPerson,
  activeSubfolder,
  setActiveSubfolder,
  activeEvent,
  setActiveEvent,
  activeTag,
  setActiveTag,
  picksCount,
  basketCount,
  rejectsCount,
  screenshotPhotosCount,
  totalBurstGroups,
  duplicatePhotosCount,
  gpsPhotosCount,
  stagedPhotosCount,
  folderTree,
  expandedFolders,
  setExpandedFolders,
  autoEvents,
  allLibraryTags,
  simpleMode = false,
  handleEmptyTrashToRecycleBin,
  onFolderContextMenu,
}: LeftSidebarProps) {
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
            <span className="text-[10px] text-zinc-500 font-mono ml-1.5 shrink-0">
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
      label: "All Photos",
      count: photos.length,
      icon: <Camera className="w-3.5 h-3.5 text-emerald-400" />,
      hideInSimple: false,
    },
    {
      id: "PICKS",
      label: simpleMode ? "Kept Photos (P)" : "Picks (P)",
      count: picksCount,
      icon: <Flag className="w-3.5 h-3.5 text-emerald-400" />,
      hideInSimple: false,
    },
    {
      id: "BASKET",
      label: simpleMode ? "Saved to Pinboard" : "Pinboard Basket (B)",
      count: basketCount,
      icon: <Pin className="w-3.5 h-3.5 text-cyan-400" />,
      hideInSimple: false,
    },
    {
      id: "REJECTS",
      label: simpleMode ? "To Delete (X)" : "Rejects (X)",
      count: rejectsCount,
      icon: <XCircle className="w-3.5 h-3.5 text-red-400" />,
      hideInSimple: false,
    },
    {
      id: "FAVORITES",
      label: "Favorites (4★+)",
      count: favoritesCount,
      icon: <Star className="w-3.5 h-3.5 text-amber-400 fill-amber-400/20" />,
      hideInSimple: false,
    },
    {
      id: "AI_TAGGED",
      label: "AI Tagged",
      count: aiTaggedCount,
      icon: <BrainCircuit className="w-3.5 h-3.5 text-indigo-400" />,
      hideInSimple: true,
    },
    {
      id: "UNTAGGED",
      label: "Untagged",
      count: untaggedCount,
      icon: <Sparkles className="w-3.5 h-3.5 text-purple-400" />,
      hideInSimple: true,
    },
    {
      id: "SCREENSHOTS",
      label: "Screenshots",
      count: screenshotPhotosCount,
      icon: <Smartphone className="w-3.5 h-3.5 text-zinc-400" />,
      hideInSimple: false,
    },
    {
      id: "DUPLICATES",
      label: simpleMode
        ? `Similar Shots (${totalBurstGroups})`
        : `Burst Groups (${totalBurstGroups})`,
      count: duplicatePhotosCount,
      icon: <Layers className="w-3.5 h-3.5 text-amber-400" />,
      hideInSimple: false,
    },
    {
      id: "HAS_OCR",
      label: simpleMode ? "Photos with Text" : "Has Text (OCR)",
      count: ocrCount,
      icon: <FileText className="w-3.5 h-3.5 text-indigo-400" />,
      hideInSimple: false,
    },
    {
      id: "HAS_GPS",
      label: simpleMode ? "Photos on Map" : "Has GPS Location",
      count: gpsPhotosCount,
      icon: <MapPin className="w-3.5 h-3.5 text-emerald-400" />,
      hideInSimple: false,
    },
    ...(stagedPhotosCount > 0
      ? [
          {
            id: "STAGED",
            label: simpleMode ? "Pending Folder Moves" : "Staged Moves",
            count: stagedPhotosCount,
            icon: <Package className="w-3.5 h-3.5 text-emerald-400" />,
            hideInSimple: false,
          },
        ]
      : []),
  ].filter((it) => !(simpleMode && it.hideInSimple));

  return (
    <aside
      style={{ width: `${leftWidth}px` }}
      className="bg-[#0c0d14] flex flex-col p-3 gap-5 overflow-y-auto shrink-0"
    >
      <div>
        <span className="text-[10px] font-bold text-zinc-500 tracking-wider uppercase">
          {simpleMode ? "Quick Filters" : "Culling & Triage"}
        </span>
        <div className="mt-2 flex flex-col gap-0.5 text-xs">
          {filterItems.map((item) => {
            const isSelected =
              smartFilter === item.id &&
              !selectedPerson &&
              activeSubfolder === "ALL" &&
              activeEvent === "ALL";
            return (
              <button
                key={item.id}
                onClick={() => {
                  setSmartFilter(item.id as SmartFilter);
                  setSelectedPerson(null);
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
                  {item.icon}
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="text-[10px] text-zinc-500 font-mono ml-1.5">{item.count}</span>
              </button>
            );
          })}
        </div>

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
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-zinc-500 tracking-wider uppercase">
              Folders
            </span>
            {activeSubfolder !== "ALL" && (
              <button
                onClick={() => setActiveSubfolder("ALL")}
                className="text-[10px] text-emerald-400 hover:underline"
              >
                Reset
              </button>
            )}
          </div>

          <div className="mt-2 flex flex-col gap-0.5 max-h-56 overflow-y-auto pr-1">
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
                <span className="text-[10px] text-zinc-500 font-mono">{folderTree.rootCount}</span>
              </div>
            )}
            {renderFolderTreeNodes(folderTree.nodes, 0)}
          </div>
        </div>
      )}

      {/* Auto-Events & Trips */}
      {autoEvents.length > 0 && (
        <div>
          <span className="text-[10px] font-bold text-zinc-500 tracking-wider uppercase">
            Events & Trips
          </span>
          <div className="mt-2 flex flex-col gap-0.5 text-xs max-h-36 overflow-y-auto">
            {autoEvents.map(([ev, count]) => (
              <button
                key={ev}
                onClick={() => setActiveEvent(ev === activeEvent ? "ALL" : ev)}
                className={`flex justify-between items-center px-2.5 py-1.5 rounded-md text-left truncate border transition ${
                  activeEvent === ev
                    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30 font-medium"
                    : "text-zinc-400 hover:bg-zinc-900/60 border-transparent"
                }`}
              >
                <span className="truncate flex items-center gap-1.5">
                  <Calendar className="w-3 h-3 shrink-0 text-emerald-400" /> {ev}
                </span>
                <span className="text-[10px] text-zinc-500 font-mono ml-1">{count}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Object Tags */}
      {allLibraryTags.length > 0 && (
        <div>
          <span className="text-[10px] font-bold text-zinc-500 tracking-wider uppercase">
            Tags ({allLibraryTags.length})
          </span>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {allLibraryTags.map((tag) => (
              <button
                key={tag}
                onClick={() => setActiveTag(tag === activeTag ? "ALL" : tag)}
                className={`px-2 py-0.5 rounded-md text-[11px] font-medium transition ${
                  activeTag === tag
                    ? "bg-indigo-600 text-white border border-indigo-500 shadow-sm"
                    : "bg-zinc-900/80 hover:bg-zinc-800 text-zinc-400 border border-zinc-800/80"
                }`}
              >
                #{tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

export default memo(LeftSidebar);
