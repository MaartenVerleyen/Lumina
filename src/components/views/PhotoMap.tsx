import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { WifiOff } from "lucide-react";

// Inline SVG pin (no marker image files to load)
const markerIcon = L.divIcon({
  className: "lumina-offline-pin",
  html: `<div style="width:26px;height:36px;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.65));">
    <svg viewBox="0 0 24 34" width="26" height="36" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 1C5.925 1 1 5.925 1 12c0 8.25 11 20.5 11 20.5S23 20.25 23 12c0-6.075-4.925-11-11-11z" fill="#10b981" stroke="#064e3b" stroke-width="1.5"/>
      <circle cx="12" cy="12" r="4.5" fill="#090a0f"/>
    </svg>
  </div>`,
  iconSize: [26, 36],
  iconAnchor: [13, 35],
  popupAnchor: [0, -32],
});

export interface MapPhotoItem {
  hash: string;
  name: string;
  path: string;
  thumb_path: string;
  thumb_ready: boolean;
  location: string;
  latitude?: number | null;
  longitude?: number | null;
  captured_at: string;
}

interface PhotoMapProps {
  photos: MapPhotoItem[];
  onSelectPhoto: (hash: string) => void;
  isPickingLocation?: boolean;
  onMapPickCoordinates?: (lat: number, lon: number) => void;
}

type GpsPhoto = MapPhotoItem & { latitude: number; longitude: number };

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function popupHtml(p: GpsPhoto): string {
  const date = p.captured_at ? p.captured_at.split(" ")[0].replace(/:/g, "-") : "";
  return `<div style="width:160px;font-size:12px;color:#0f172a;display:flex;flex-direction:column;gap:4px">
    <img src="${escapeHtml(convertFileSrc(p.thumb_ready ? p.thumb_path : p.path))}" alt="" style="width:100%;height:96px;object-fit:cover;border-radius:4px"/>
    <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(p.name)}</div>
    ${p.location ? `<div style="font-size:11px;color:#047857">${escapeHtml(p.location)}</div>` : ""}
    ${date ? `<div style="font-size:10px;color:#64748b">${escapeHtml(date)}</div>` : ""}
  </div>`;
}

// Map clicks (GPS picking) and the crosshair cursor while picking
function MapClickHandler({
  isPickingLocation,
  onMapPickCoordinates,
}: {
  isPickingLocation?: boolean;
  onMapPickCoordinates?: (lat: number, lon: number) => void;
}) {
  const map = useMapEvents({
    click(e) {
      if (isPickingLocation && onMapPickCoordinates) {
        onMapPickCoordinates(e.latlng.lat, e.latlng.lng);
      }
    },
  });
  useEffect(() => {
    map.getContainer().style.cursor = isPickingLocation ? "crosshair" : "";
  }, [map, isPickingLocation]);
  return null;
}

// Clustered markers: thousands of photos stay fast and readable. The view fits the photos whenever the set
// of geotagged photos changes (opening a folder, changing a filter), not on every unrelated update.
function ClusteredMarkers({ photos, onSelectPhoto }: { photos: GpsPhoto[]; onSelectPhoto: (hash: string) => void }) {
  const map = useMap();
  const onSelectRef = useRef(onSelectPhoto);
  onSelectRef.current = onSelectPhoto;
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const lastFitRef = useRef("");
  const photosRef = useRef(photos);
  photosRef.current = photos;
  // Flagging or rating a photo creates new photo objects; the markers only need rebuilding when a pin
  // (or its popup thumbnail) actually changes
  const markerKey = useMemo(
    () => photos.map((p) => `${p.hash}:${p.latitude}:${p.longitude}:${p.thumb_ready ? 1 : 0}`).join("|"),
    [photos]
  );

  useEffect(() => {
    const group = L.markerClusterGroup({ showCoverageOnHover: false, maxClusterRadius: 50, chunkedLoading: true });
    clusterRef.current = group;
    map.addLayer(group);
    return () => {
      map.removeLayer(group);
      clusterRef.current = null;
    };
  }, [map]);

  useEffect(() => {
    const group = clusterRef.current;
    if (!group) return;
    const photos = photosRef.current;
    group.clearLayers();
    group.addLayers(
      photos.map((p) =>
        L.marker([p.latitude, p.longitude], { icon: markerIcon, title: p.name })
          .bindPopup(popupHtml(p))
          .on("click", () => onSelectRef.current(p.hash))
      )
    );

    if (photos.length === 0) return;
    const bounds = L.latLngBounds(photos.map((p) => [p.latitude, p.longitude] as [number, number]));
    const signature = `${photos.length}|${bounds.toBBoxString()}`;
    if (signature !== lastFitRef.current) {
      lastFitRef.current = signature;
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
    }
  }, [map, markerKey]);

  return null;
}

export default function PhotoMap({
  photos,
  onSelectPhoto,
  isPickingLocation = false,
  onMapPickCoordinates,
}: PhotoMapProps) {
  const gpsPhotos = useMemo(
    () =>
      photos.filter(
        (p): p is GpsPhoto => typeof p.latitude === "number" && typeof p.longitude === "number"
      ),
    [photos]
  );
  // Map tiles come from OpenStreetMap: without internet the map is blank, but the markers still work
  const [tilesFailing, setTilesFailing] = useState(false);

  // Default center: Meise / Brussels, Belgium if no GPS photos exist yet (fitBounds takes over otherwise)
  const defaultCenter: [number, number] = [50.9333, 4.3333];

  return (
    <div className="relative flex-1 w-full h-full overflow-hidden">
      {tilesFailing && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[500] px-3 py-1.5 rounded-lg bg-zinc-900/95 border border-amber-500/40 text-amber-200 text-xs flex items-center gap-2 shadow-xl">
          <WifiOff className="w-3.5 h-3.5" />
          <span>Map tiles can't be loaded (no internet connection?). Photo pins still work.</span>
        </div>
      )}
      <MapContainer center={defaultCenter} zoom={5} className="w-full h-full z-0">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          eventHandlers={{
            tileerror: () => setTilesFailing(true),
            tileload: () => setTilesFailing(false),
          }}
        />

        <MapClickHandler
          isPickingLocation={isPickingLocation}
          onMapPickCoordinates={onMapPickCoordinates}
        />

        <ClusteredMarkers photos={gpsPhotos} onSelectPhoto={onSelectPhoto} />
      </MapContainer>
    </div>
  );
}
