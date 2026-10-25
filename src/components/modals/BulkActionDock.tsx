import { useEffect, useState } from "react";
import { CitySearchResult, PhotoItem } from "../../types/lumina";
import {
  CheckSquare,
  Clock,
  Columns,
  Crosshair,
  Flag,
  Folder,
  MapPin,
  Pin,
  RefreshCw,
  RotateCcw as RotateLeft,
  RotateCw,
  Sparkles,
  Star,
  Tag as TagIcon,
  Trash2,
  User,
  X,
  XCircle,
} from "lucide-react";

// Number field that accepts a leading "-" while typing: the text is kept as typed and the parent
// only receives a number once the text is a valid integer (a controlled number input reset "-" to 0).
function SignedIntInput({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    // Follow outside changes (e.g. reset to 0 after applying) but keep "-" or "" while typing
    const parsed = parseInt(text, 10);
    if ((Number.isNaN(parsed) ? 0 : parsed) !== value) setText(String(value));
  }, [value]);
  return (
    <input
      type="text"
      inputMode="numeric"
      value={text}
      onChange={(e) => {
        const next = e.target.value.replace(/[^\d-]/g, "").replace(/(?!^)-/g, "");
        setText(next);
        const n = parseInt(next, 10);
        onChange(Number.isNaN(n) ? 0 : n);
      }}
      className="bg-zinc-950 border border-zinc-800 rounded px-2 py-1 text-xs text-zinc-200"
    />
  );
}

interface BulkActionDockProps {
  selectedHashes: Set<string>;
  setSelectedHashes: React.Dispatch<React.SetStateAction<Set<string>>>;
  visiblePhotos: PhotoItem[];
  activeBulkPopover: "tag" | "person" | "move" | "location" | "time" | null;
  setActiveBulkPopover: React.Dispatch<
    React.SetStateAction<"tag" | "person" | "move" | "location" | "time" | null>
  >;
  bulkInput: string;
  setBulkInput: React.Dispatch<React.SetStateAction<string>>;
  citySearchResults: CitySearchResult[];
  shiftHoursInput: number;
  setShiftHoursInput: React.Dispatch<React.SetStateAction<number>>;
  shiftMinutesInput: number;
  setShiftMinutesInput: React.Dispatch<React.SetStateAction<number>>;
  setIsPickingMapLocation: React.Dispatch<React.SetStateAction<boolean>>;
  setViewMode: React.Dispatch<React.SetStateAction<"grid" | "map" | "compare">>;
  setCompareZoom: React.Dispatch<React.SetStateAction<number>>;
  setComparePan: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  handleSetFlag: (flag: "pick" | "reject" | null) => Promise<void>;
  handleBatchRate: (rating: number) => Promise<void>;
  handleSetColorLabel: (color: "red" | "yellow" | "green" | "blue" | null) => Promise<void>;
  handleRotateSelection: (deltaDegrees: number) => Promise<void>;
  handleBatchAddTag: (tag: string) => Promise<void>;
  handleBatchStageMove: (targetSub: string | null) => Promise<void>;
  handleSearchCities: (q: string) => Promise<void>;
  handleAssignCity: (c: CitySearchResult) => Promise<void>;
  handleShiftTimestamps: (e: React.FormEvent) => Promise<void>;
  handleToggleBasketSelection: () => Promise<void>;
  handleForceRescanExifSelected: () => Promise<void>;
  runBatchAiOnList: (targets: PhotoItem[]) => Promise<void>;
  handleBatchAssignPerson?: (personName: string) => Promise<void>;
}

export default function BulkActionDock({
  selectedHashes,
  setSelectedHashes,
  visiblePhotos,
  activeBulkPopover,
  setActiveBulkPopover,
  bulkInput,
  setBulkInput,
  citySearchResults,
  shiftHoursInput,
  setShiftHoursInput,
  shiftMinutesInput,
  setShiftMinutesInput,
  setIsPickingMapLocation,
  setViewMode,
  setCompareZoom,
  setComparePan,
  handleSetFlag,
  handleBatchRate,
  handleSetColorLabel,
  handleRotateSelection,
  handleBatchAddTag,
  handleBatchStageMove,
  handleSearchCities,
  handleAssignCity,
  handleShiftTimestamps,
  handleToggleBasketSelection,
  handleForceRescanExifSelected,
  runBatchAiOnList,
  handleBatchAssignPerson,
}: BulkActionDockProps) {
  if (selectedHashes.size <= 1) return null;

  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-50 animate-in fade-in slide-in-from-bottom-2">
      {/* Dynamic Inline Bulk Popover */}
      {activeBulkPopover && (
        <div className="bg-[#10121a] border border-zinc-700 p-3 rounded-xl shadow-2xl flex flex-col gap-2 w-80 text-xs">
          <div className="flex justify-between items-center text-zinc-300 font-semibold">
            <span>
              {activeBulkPopover === "tag" && "Add Tag to Selection"}
              {activeBulkPopover === "person" && "Assign Person to Selection"}
              {activeBulkPopover === "move" && "Stage Move Selection"}
              {activeBulkPopover === "location" && "Set Manual Location (City/GPS)"}
              {activeBulkPopover === "time" && "Shift Capture Timestamps (± Hours / Min)"}
            </span>
            <button
              onClick={() => setActiveBulkPopover(null)}
              className="text-zinc-500 hover:text-white"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          {activeBulkPopover === "tag" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleBatchAddTag(bulkInput);
              }}
              className="flex gap-1.5"
            >
              <input
                type="text"
                value={bulkInput}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => setBulkInput(e.target.value)}
                placeholder="e.g. vacation, portrait..."
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 select-text focus:outline-none focus:border-indigo-500"
                autoFocus
              />
              <button
                type="submit"
                className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium"
              >
                Add
              </button>
            </form>
          )}

          {activeBulkPopover === "person" && handleBatchAssignPerson && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleBatchAssignPerson(bulkInput);
              }}
              className="flex gap-1.5"
            >
              <input
                type="text"
                value={bulkInput}
                onKeyDown={(e) => e.stopPropagation()}
                onChange={(e) => setBulkInput(e.target.value)}
                placeholder="Person name..."
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 select-text focus:outline-none focus:border-indigo-500"
                autoFocus
              />
              <button
                type="submit"
                className="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-500 text-white rounded font-medium"
              >
                Assign
              </button>
            </form>
          )}

          {activeBulkPopover === "move" && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleBatchStageMove(bulkInput);
              }}
              className="flex gap-1.5"
            >
              <input
                type="text"
                value={bulkInput}
                onChange={(e) => setBulkInput(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="e.g. 2026/Holiday"
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500"
                autoFocus
              />
              <button
                type="submit"
                className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-medium"
              >
                Stage
              </button>
            </form>
          )}

          {activeBulkPopover === "location" && (
            <div className="flex flex-col gap-1.5">
              <input
                type="text"
                value={bulkInput}
                onChange={(e) => handleSearchCities(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search city (e.g. Meise, Paris, Brussels)..."
                className="bg-zinc-950 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-emerald-500"
                autoFocus
              />
              {citySearchResults.length > 0 && (
                <div className="max-h-36 overflow-y-auto flex flex-col gap-1 mt-1">
                  {citySearchResults.map((c) => (
                    <button
                      key={`${c.name}_${c.country}`}
                      onClick={() => handleAssignCity(c)}
                      className="text-left px-2 py-1 bg-zinc-900 hover:bg-zinc-800 rounded flex justify-between text-zinc-300"
                    >
                      <span>
                        {c.name}, {c.country}
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">
                        {c.latitude.toFixed(2)}, {c.longitude.toFixed(2)}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={() => {
                  setActiveBulkPopover(null);
                  setIsPickingMapLocation(true);
                  setViewMode("map");
                }}
                className="mt-1 px-2.5 py-1.5 bg-emerald-950/60 hover:bg-emerald-900/70 border border-emerald-500/40 text-emerald-300 rounded-lg text-center font-medium transition flex items-center justify-center gap-1.5"
              >
                <Crosshair className="w-3.5 h-3.5" />
                <span>Or Click Directly on Map to Set GPS</span>
              </button>
            </div>
          )}

          {activeBulkPopover === "time" && (
            <form onSubmit={handleShiftTimestamps} className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="text-[10px] text-zinc-500">Hours (±)</span>
                  <SignedIntInput value={shiftHoursInput} onChange={setShiftHoursInput} />
                </div>
                <div className="flex-1 flex flex-col gap-0.5">
                  <span className="text-[10px] text-zinc-500">Minutes (±)</span>
                  <SignedIntInput value={shiftMinutesInput} onChange={setShiftMinutesInput} />
                </div>
              </div>
              <button
                type="submit"
                className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded font-semibold"
              >
                Apply Time Shift
              </button>
            </form>
          )}
        </div>
      )}

      {/* Main Dock */}
      <div className="bg-[#12141c]/95 border border-zinc-700/60 shadow-2xl backdrop-blur-xl px-4 py-2 rounded-2xl flex items-center gap-2.5 text-xs">
        <div className="flex items-center gap-1.5 font-semibold text-zinc-200 border-r border-zinc-700 pr-2.5">
          <CheckSquare className="w-4 h-4 text-emerald-400" />
          <span>{selectedHashes.size} Selected</span>
        </div>

        {/* Pick / Reject / Unflag */}
        <div className="flex items-center gap-1 border-r border-zinc-700 pr-2.5">
          <button
            onClick={() => handleSetFlag("pick")}
            className="px-1.5 py-1 hover:bg-emerald-950/60 text-emerald-400 rounded flex items-center gap-1"
            title="Pick (P)"
          >
            <Flag className="w-3.5 h-3.5" />
            <span>Pick</span>
          </button>
          <button
            onClick={() => handleSetFlag("reject")}
            className="px-1.5 py-1 hover:bg-red-950/60 text-red-400 rounded flex items-center gap-1"
            title="Reject (X)"
          >
            <XCircle className="w-3.5 h-3.5" />
            <span>Reject</span>
          </button>
          <button
            onClick={() => handleSetFlag(null)}
            className="px-1.5 py-1 text-zinc-500 hover:text-zinc-300"
            title="Unflag (U)"
          >
            Unflag
          </button>
        </div>

        {/* Interactive 1-5 Star Rating in Bulk Dock */}
        <div className="flex items-center gap-0.5 border-r border-zinc-700 pr-2.5">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              onClick={() => handleBatchRate(star)}
              className="p-0.5 text-zinc-500 hover:text-amber-400 transition"
              title={`Rate selection ${star}★`}
            >
              <Star className="w-3.5 h-3.5 hover:fill-amber-400" />
            </button>
          ))}
          <button
            onClick={() => handleBatchRate(0)}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 ml-1"
            title="Clear rating (0)"
          >
            0★
          </button>
        </div>

        {/* Color Labels */}
        <div className="flex items-center gap-1 border-r border-zinc-700 pr-2.5">
          <button
            onClick={() => handleSetColorLabel("red")}
            className="w-3.5 h-3.5 rounded-full bg-red-500 hover:scale-110 transition"
            title="Red (6)"
          />
          <button
            onClick={() => handleSetColorLabel("yellow")}
            className="w-3.5 h-3.5 rounded-full bg-yellow-400 hover:scale-110 transition"
            title="Yellow (7)"
          />
          <button
            onClick={() => handleSetColorLabel("green")}
            className="w-3.5 h-3.5 rounded-full bg-emerald-500 hover:scale-110 transition"
            title="Green (8)"
          />
          <button
            onClick={() => handleSetColorLabel("blue")}
            className="w-3.5 h-3.5 rounded-full bg-blue-500 hover:scale-110 transition"
            title="Blue (9)"
          />
          <button
            onClick={() => handleSetColorLabel(null)}
            className="text-[10px] text-zinc-500 hover:text-zinc-300 ml-1"
          >
            Clear
          </button>
        </div>

        {/* Non-Destructive Rotation */}
        <div className="flex items-center gap-1 border-r border-zinc-700 pr-2.5">
          <button
            onClick={() => handleRotateSelection(-90)}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white"
            title="Rotate Left ([)"
          >
            <RotateLeft className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => handleRotateSelection(90)}
            className="p-1 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white"
            title="Rotate Right (])"
          >
            <RotateCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Popover Action Buttons */}
        <button
          onClick={() => {
            setActiveBulkPopover(activeBulkPopover === "tag" ? null : "tag");
            setBulkInput("");
          }}
          className="flex items-center gap-1 text-zinc-300 hover:text-white"
        >
          <TagIcon className="w-3.5 h-3.5 text-indigo-400" />
          <span>Tag</span>
        </button>

        {handleBatchAssignPerson && (
          <button
            onClick={() => {
              setActiveBulkPopover(activeBulkPopover === "person" ? null : "person");
              setBulkInput("");
            }}
            className="flex items-center gap-1 text-zinc-300 hover:text-white"
            title="Assign Person to selected photos"
          >
            <User className="w-3.5 h-3.5 text-indigo-400" />
            <span>Person</span>
          </button>
        )}

        <button
          onClick={() => {
            setActiveBulkPopover(activeBulkPopover === "move" ? null : "move");
            setBulkInput("");
          }}
          className="flex items-center gap-1 text-zinc-300 hover:text-white"
        >
          <Folder className="w-3.5 h-3.5 text-emerald-400" />
          <span>Move</span>
        </button>

        <button
          onClick={() => {
            setActiveBulkPopover(activeBulkPopover === "location" ? null : "location");
            setBulkInput("");
          }}
          className="flex items-center gap-1 text-zinc-300 hover:text-white"
        >
          <MapPin className="w-3.5 h-3.5 text-emerald-400" />
          <span>Location</span>
        </button>

        <button
          onClick={() => {
            setActiveBulkPopover(activeBulkPopover === "time" ? null : "time");
          }}
          className="flex items-center gap-1 text-zinc-300 hover:text-white"
          title="Shift capture timestamps (± Hours/Min)"
        >
          <Clock className="w-3.5 h-3.5 text-cyan-400" />
          <span>Time</span>
        </button>

        <button
          onClick={handleToggleBasketSelection}
          className="flex items-center gap-1 text-zinc-300 hover:text-white"
          title="Toggle Pinboard Basket (B)"
        >
          <Pin className="w-3.5 h-3.5 text-cyan-400" />
          <span>Pin</span>
        </button>

        <button
          onClick={() => {
            setCompareZoom(1);
            setComparePan({ x: 0, y: 0 });
            setViewMode("compare");
          }}
          className="flex items-center gap-1 text-zinc-300 hover:text-white"
          title="Compare selected photos side-by-side (C)"
        >
          <Columns className="w-3.5 h-3.5 text-emerald-400" />
          <span>Compare</span>
        </button>

        <button
          onClick={handleForceRescanExifSelected}
          className="flex items-center gap-1 text-zinc-300 hover:text-white"
          title="Force refresh EXIF headers on selected photos"
        >
          <RefreshCw className="w-3.5 h-3.5 text-zinc-400" />
          <span>EXIF</span>
        </button>

        <button
          onClick={() => {
            const targets = visiblePhotos.filter((p) => selectedHashes.has(p.hash));
            runBatchAiOnList(targets);
          }}
          className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 font-medium"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>AI</span>
        </button>

        <button
          onClick={() => handleBatchStageMove("_Trash")}
          className="flex items-center gap-1 text-red-400 hover:text-red-300 font-medium border-l border-zinc-700 pl-2.5"
        >
          <Trash2 className="w-3.5 h-3.5" />
          <span>Trash</span>
        </button>

        <button
          onClick={() => setSelectedHashes(new Set())}
          className="text-zinc-500 hover:text-zinc-300 ml-1"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
