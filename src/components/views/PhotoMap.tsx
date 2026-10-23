import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Calendar, MapPin } from "lucide-react";

// Offline-safe inline SVG DivIcon marker (Zero external network dependency!)
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

function MapClickHandler({
  isPickingLocation,
  onMapPickCoordinates,
}: {
  isPickingLocation?: boolean;
  onMapPickCoordinates?: (lat: number, lon: number) => void;
}) {
  useMapEvents({
    click(e) {
      if (isPickingLocation && onMapPickCoordinates) {
        onMapPickCoordinates(e.latlng.lat, e.latlng.lng);
      }
    },
  });
  return null;
}

export default function PhotoMap({
  photos,
  onSelectPhoto,
  isPickingLocation = false,
  onMapPickCoordinates,
}: PhotoMapProps) {
  const gpsPhotos = photos.filter(
    (p) => typeof p.latitude === "number" && typeof p.longitude === "number"
  );

  // Default center: Meise / Brussels, Belgium if no GPS photos exist yet
  const defaultCenter: [number, number] =
    gpsPhotos.length > 0
      ? [gpsPhotos[0].latitude as number, gpsPhotos[0].longitude as number]
      : [50.9333, 4.3333];

  useEffect(() => {
    const container = document.querySelector(".leaflet-container") as HTMLElement | null;
    if (container) {
      container.style.cursor = isPickingLocation ? "crosshair" : "";
    }
  }, [isPickingLocation]);

  return (
    <div className="relative flex-1 w-full h-full overflow-hidden">
      <MapContainer
        center={defaultCenter}
        zoom={gpsPhotos.length > 0 ? 6 : 5}
        className="w-full h-full z-0"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />

        <MapClickHandler
          isPickingLocation={isPickingLocation}
          onMapPickCoordinates={onMapPickCoordinates}
        />

        {gpsPhotos.map((p) => (
          <Marker
            key={p.hash}
            position={[p.latitude as number, p.longitude as number]}
            icon={markerIcon}
            eventHandlers={{
              click: () => onSelectPhoto(p.hash),
            }}
          >
            <Popup>
              <div className="flex flex-col gap-1.5 w-40 text-xs text-slate-900">
                <img
                  src={convertFileSrc(p.thumb_ready ? p.thumb_path : p.path)}
                  alt={p.name}
                  className="w-full h-24 object-cover rounded"
                />
                <div className="font-bold truncate">{p.name}</div>
                {p.location && (
                  <div className="text-[11px] text-emerald-700 flex items-center gap-1">
                    <MapPin className="w-3 h-3 shrink-0" />
                    <span className="truncate">{p.location}</span>
                  </div>
                )}
                {p.captured_at && (
                  <div className="text-[10px] text-slate-500 flex items-center gap-1">
                    <Calendar className="w-3 h-3 shrink-0" />
                    <span>{p.captured_at.split(" ")[0].replace(/:/g, "-")}</span>
                  </div>
                )}
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
