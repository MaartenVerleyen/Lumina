import { Compass, Crosshair, MapPin } from "lucide-react";
import PhotoMap from "./PhotoMap";
import type { LibraryState } from "../../hooks/useLibraryState";

// The Map tab: the map with a bar to assign GPS to the selection by clicking the map
export default function MapPane({ lib }: { lib: LibraryState }) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden relative">
      <div className="bg-zinc-900/95 border-b border-zinc-800 px-4 py-2 flex items-center justify-between text-xs z-10">
        <div className="flex items-center gap-2">
          {lib.isPickingMapLocation ? (
            <Crosshair className="w-4 h-4 text-emerald-400 animate-pulse" />
          ) : (
            <Compass className="w-4 h-4 text-emerald-400" />
          )}
          <span className="text-zinc-300">
            {lib.isPickingMapLocation
              ? `Click anywhere on the map to assign GPS coordinates to ${lib.selectedHashes.size} selected photo(s)...`
              : `Showing ${lib.gpsPhotosCount} geotagged photos on map.`}
          </span>
        </div>
        <button
          onClick={() => lib.setIsPickingMapLocation((p) => !p)}
          disabled={lib.selectedHashes.size === 0}
          className={`px-3 py-1 rounded-lg font-semibold transition flex items-center gap-1.5 ${
            lib.isPickingMapLocation
              ? "bg-emerald-600 text-white shadow"
              : "bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700"
          }`}
        >
          <MapPin className="w-3.5 h-3.5" />
          <span>
            {lib.isPickingMapLocation
              ? "Cancel Map Pick"
              : `Click Map to Set GPS (${lib.selectedHashes.size})`}
          </span>
        </button>
      </div>
      <PhotoMap
        photos={lib.visiblePhotos}
        onSelectPhoto={(h) => lib.setActiveHash(h)}
        isPickingLocation={lib.isPickingMapLocation}
        onMapPickCoordinates={lib.handleMapPickCoordinates}
      />
    </div>
  );
}
