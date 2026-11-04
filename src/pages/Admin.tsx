import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDropzone } from 'react-dropzone';
import {
  Eye, Home, BarChart2, Film, MapPin, Upload,
  Plus, Trash2, Video, LogOut, ExternalLink,
  CheckCircle2, Menu, X, Camera, FileText,
  ChevronDown, ChevronUp, Settings, Signal, Users, Info,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/use-toast';
import { ZoomableImage } from '@/components/ImageModalContext';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import {
  fetchAppPages,
  fetchSiteContent,
  fetchSiteFlags,
  fetchAllDeployments,
  setAppPageEnabled,
  setSiteContent,
  setSiteFlag,
  setDeployment,
  deleteDeployment,
  uploadFileToBucket,
  fetchAllDeviceMasterData,
  upsertDeviceMasterData,
  deleteDeviceMasterData,
  type SiteFlagKey,
  type DeploymentRecord,
  type DeviceMasterData,
  type StorageBucketName,
} from '@/lib/siteAdmin';
import {
  mergeHomeContentWithDefaults,
  mergePartnersContentWithDefaults,
  IWA_DIGITAL_WATER_SUMMIT_CERTIFICATE_TITLE,
} from '@/lib/contentDefaults';
import {
  resolveImageSrc,
  toDrivePreviewUrl,
  extractDriveFileId,
  toDriveStreamUrl
} from '@/lib/driveLinks';
import { useLiveDevices } from '@/hooks/useLiveDevices';
import { SurveyAdminSection } from '@/components/SurveyAdminSection';
import { syncPortableReadings } from '@/lib/surveySync';
import { isPortableDeviceBatch, matchDistrictName } from '@/lib/data';
import { firebaseConfig } from '@/lib/firebaseClient';
import {
  addDaysToDateKey,
  depthChangeOverDays,
  detectPumpRunRanges,
  fetchRtdbReadingsSince,
  deviceHealthForDay,
  isCountablePumpRun,
  istDateKey,
  istNoonIso,
  isUsableDepth,
  medianOf,
  type PumpPoint,
  readingQualityOk,
  readingTimestampMs,
  rollingCalendarWindow,
  syncWindowStartMs,
  wellAreaM2,
  wellSafety,
} from '../../supabase/functions/_shared/sensorLogic';

// Supabase returns plain { message, code } objects, not Error instances.
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const { message, code } = err as { message: unknown; code?: unknown };
    return code ? `${String(message)} (${String(code)})` : String(message);
  }
  return String(err);
}

// ─── Types ────────────────────────────────────────────────────────────────────

type AdminSection =
  | 'visibility'
  | 'hero'
  | 'insights'
  | 'dashboard'
  | 'validation'
  | 'contact'
  | 'deployments-preview'
  | 'deployments-page'
  | 'partners'
  | 'devices'
  | 'master-tables'
  | 'surveys'
  | 'media';

type Installation = { title: string; videoUrl: string; notes: string; mediaCsv?: string };

// ─── Sidebar config ───────────────────────────────────────────────────────────

const SIDEBAR_ITEMS: Array<{
  id: AdminSection;
  icon: React.ElementType;
  label: string;
  desc: string;
}> = [
    { id: 'visibility', icon: Eye, label: 'Visibility & Pages', desc: 'Toggle sections & enable routes' },
    { id: 'hero', icon: Home, label: 'Hero Section', desc: 'Headline, tagline & media' },
    { id: 'insights', icon: CheckCircle2, label: 'Insights Section', desc: 'How-it-works cards + copy' },
    { id: 'dashboard', icon: BarChart2, label: 'Dashboard Section', desc: 'KPI cards, alerts & map' },
    { id: 'validation', icon: FileText, label: 'Validation Section', desc: 'Certificates + testimonials' },
    { id: 'contact', icon: Settings, label: 'Contact Section', desc: 'Pilot CTA + form copy' },
    { id: 'deployments-page', icon: MapPin, label: 'Deployments Page', desc: 'Manage all entries & home preview' },
    { id: 'partners', icon: Users, label: 'Partners Page', desc: 'Krushi Vikas video & photo gallery' },
    { id: 'devices', icon: Signal, label: 'Live Devices', desc: 'Pump vs non-pump per live device' },
    { id: 'master-tables', icon: FileText, label: 'Master & Telemetry', desc: 'Live Edge calculations & Supabase tables' },
    { id: 'surveys', icon: MapPin, label: 'Surveys', desc: 'Portable surveys, device well list & sync' },
    { id: 'media', icon: Upload, label: 'Media Upload', desc: 'Upload images, videos & PDFs' },
  ];

const FLAG_DEFS: Array<{ key: SiteFlagKey; label: string; description: string }> = [
  { key: 'show_deployments', label: 'Deployments section', description: 'Show/hide deployment cards section on Home.' },
  { key: 'show_validation', label: 'Validation section', description: 'Show/hide validation section on Home.' },
  { key: 'show_image_carousel', label: 'Image carousel', description: 'Show/hide carousel section on Home (if present).' },
];

// ─── Video Thumbnail Picker ──────────────────────────────────────────────────

function VideoThumbnailPicker({
  videoUrl,
  onCapture,
  disabled,
  bucket = 'site-media'
}: {
  videoUrl: string;
  onCapture: (url: string) => void;
  disabled?: boolean;
  bucket?: StorageBucketName;
}) {
  const [capturing, setCapturing] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const captureFrame = async () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    setCapturing(true);
    try {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      canvas.toBlob(async (blob) => {
        if (!blob) return;
        const file = new File([blob], `thumbnail-${Date.now()}.jpg`, { type: 'image/jpeg' });
        const res = await uploadFileToBucket(bucket, file, { folder: 'thumbnails' });
        onCapture(res.publicUrl);
        toast({ title: 'Thumbnail captured!' });
      }, 'image/jpeg', 0.85);
    } catch (err) {
      toast({ title: 'Capture failed', variant: 'destructive' });
    } finally {
      setCapturing(false);
    }
  };

  const displayUrl = toDriveStreamUrl(videoUrl) || videoUrl;
  const isDrive = !!extractDriveFileId(videoUrl);

  return (
    <div className="space-y-3 rounded-xl border border-teal-100 bg-teal-50/20 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-bold uppercase tracking-wider text-teal-700">Set Video Thumbnail</p>
        <Button
          type="button"
          size="sm"
          onClick={captureFrame}
          disabled={disabled || capturing || isDrive}
          className="bg-teal-600 hover:bg-teal-700 text-white h-7 text-[10px]"
        >
          {capturing ? 'Capturing...' : 'Capture current frame'}
        </Button>
      </div>
      <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
        {isDrive ? (
          <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center">
            <Video className="mb-2 h-8 w-8 text-teal-200/50" />
            <p className="text-[11px] font-medium text-teal-100/80">Custom thumbnails are not supported for Google Drive links due to security (CORS) restrictions.</p>
            <p className="mt-1 text-[10px] text-teal-100/50">To choose a specific frame, please upload the video file directly to Supabase.</p>
          </div>
        ) : (
          <>
            <video
              ref={videoRef}
              src={displayUrl}
              controls
              className="h-full w-full object-contain"
              crossOrigin="anonymous"
            />
            <canvas ref={canvasRef} className="hidden" />
          </>
        )}
      </div>
      {!isDrive && (
        <p className="text-[10px] text-muted-foreground leading-tight">
          Seek to the frame you want to use as a preview, then click "Capture".
        </p>
      )}
    </div>
  );
}


// ─── MediaUploadField ─────────────────────────────────────────────────────────

interface MediaUploadFieldProps {
  label: string;
  hint?: string;
  value: string;
  onChange: (url: string) => void;
  onThumbnail?: (url: string) => void;
  bucket?: StorageBucketName;
  folder?: string;
  mediaType?: 'image' | 'video' | 'any';
  disabled?: boolean;
  showManualUrl?: boolean;
}

function MediaUploadField({
  label,
  hint,
  value,
  onChange,
  onThumbnail,
  bucket = 'site-media',
  folder = 'uploads',
  mediaType = 'any',
  disabled,
  showManualUrl = true,
}: MediaUploadFieldProps) {
  const [uploading, setUploading] = useState(false);

  const accept = useMemo(() => {
    if (mediaType === 'image') return { 'image/*': [] };
    if (mediaType === 'video') return { 'video/*': [] };
    return { 'image/*': [], 'video/*': [], 'application/pdf': [] };
  }, [mediaType]);

  const onDrop = useCallback(
    async (files: File[]) => {
      const file = files[0];
      if (!file) return;
      setUploading(true);
      try {
        const res = await uploadFileToBucket(bucket, file, { folder });
        onChange(res.publicUrl);
        toast({ title: 'File uploaded successfully' });
      } catch (err) {
        toast({
          title: 'Upload failed',
          description: errorMessage(err),
          variant: 'destructive',
        });
      } finally {
        setUploading(false);
      }
    },
    [bucket, folder, onChange],
  );

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    disabled: disabled || uploading,
    multiple: false,
    accept,
    maxSize: 200 * 1024 * 1024,
  });

  const trimmed = value.trim();
  const driveId = extractDriveFileId(trimmed);
  const drivePreview = toDrivePreviewUrl(trimmed);

  // Improved detection for Google Drive links which don't have file extensions
  const isImage = mediaType === 'image' ||
    /\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/i.test(trimmed) ||
    (driveId && mediaType === 'image');

  const isVideo = mediaType === 'video' ||
    /\.(mp4|webm|mov|avi|mkv)(\?|$)/i.test(trimmed) ||
    (driveId && mediaType === 'video');

  const isAnyFile = !isImage && !isVideo && trimmed.length > 0;


  return (
    <div className="space-y-2">
      <div>
        <p className="text-sm font-medium text-foreground">{label}</p>
        {hint && <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>}
      </div>

      {/* Current value preview */}
      {trimmed && (
        <div className="relative rounded-xl overflow-hidden border border-border">
          {drivePreview && isVideo ? (
            <div className="h-36 w-full bg-black">
              <iframe
                title={label}
                src={drivePreview}
                className="h-full w-full"
                allow="autoplay; encrypted-media"
                allowFullScreen
              />
            </div>
          ) : isImage ? (
            <ZoomableImage src={resolveImageSrc(trimmed)} alt={label} className="h-36 w-full object-cover" />
          ) : isVideo ? (
            <div className="flex h-20 items-center gap-3 bg-black/5 px-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100">
                <Video className="h-5 w-5 text-blue-600" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Video file set</p>
                <p className="truncate text-xs text-muted-foreground">{trimmed}</p>
              </div>
            </div>
          ) : isAnyFile ? (
            <div className="flex h-20 items-center gap-3 bg-muted/20 px-4">
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-orange-100">
                <FileText className="h-5 w-5 text-orange-600" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">Document / File set</p>
                <p className="truncate text-xs text-muted-foreground">{trimmed}</p>
              </div>
            </div>
          ) : (
            <div className="flex h-14 items-center gap-3 bg-muted/20 px-4">
              <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-green-600" />
              <p className="truncate text-xs text-muted-foreground">{trimmed}</p>
            </div>
          )}
          <button
            type="button"
            onClick={() => onChange('')}
            disabled={disabled}
            className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white shadow transition hover:bg-red-600 disabled:opacity-50 z-10"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {isVideo && trimmed && (
        <VideoThumbnailPicker
          videoUrl={trimmed}
          onCapture={(url) => {
            if (onThumbnail) {
              onThumbnail(url);
            } else {
              toast({ title: 'Thumbnail URL copied!', description: url });
              navigator.clipboard.writeText(url);
            }
          }}
          disabled={disabled}
          bucket={bucket}
        />
      )}

      {/* Drop zone */}
      <div
        {...getRootProps()}
        className={cn(
          'cursor-pointer rounded-xl border-2 border-dashed p-5 text-center transition-colors',
          isDragReject ? 'border-red-400 bg-red-50/30' :
            isDragActive ? 'border-teal-500 bg-teal-50/20' :
              'border-border hover:border-teal-400 hover:bg-teal-50/10',
          (disabled || uploading) && 'pointer-events-none opacity-50',
        )}
      >
        <input {...getInputProps()} />
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
            <Upload className="h-4 w-4 text-muted-foreground" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {uploading ? 'Uploading…' : isDragActive ? 'Drop to upload' : trimmed ? 'Replace file' : 'Upload file'}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {mediaType === 'image' ? 'JPG, PNG, WebP · ' : mediaType === 'video' ? 'MP4, WebM · ' : 'Images, Videos, PDFs · '}
              Drag & drop or click to browse
            </p>
          </div>
        </div>
      </div>

      {showManualUrl ? (
        <Input
          value={trimmed}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Or paste a URL manually"
          disabled={disabled}
          className="font-mono text-xs"
        />
      ) : null}
    </div>
  );
}

// ─── Small helper components ──────────────────────────────────────────────────

function SectionHeader({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-6 border-b border-border pb-4">
      <h2 className="text-lg font-bold text-foreground">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
    </div>
  );
}

function FieldLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mb-1">
      <p className="text-sm font-medium text-foreground">{label}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function SaveBar({
  onSave,
  onReset,
  saving,
  dirty,
}: {
  onSave: () => void;
  onReset: () => void;
  saving: boolean;
  dirty: boolean;
}) {
  return (
    <div className="mt-6 flex items-center justify-end gap-3 border-t border-border pt-4">
      <Button variant="outline" onClick={onReset} disabled={saving || !dirty}>
        Discard changes
      </Button>
      <Button
        onClick={onSave}
        disabled={saving || !dirty}
        className="bg-teal-600 hover:bg-teal-700 text-white"
      >
        {saving ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  );
}

// ─── Installation card ────────────────────────────────────────────────────────

function InstallationCard({
  inst,
  index,
  onChange,
  onRemove,
  disabled,
}: {
  inst: Installation;
  index: number;
  onChange: (updated: Installation) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(true);

  return (
    <Card className="overflow-hidden">
      <div
        className="flex cursor-pointer items-center justify-between gap-3 p-4"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-teal-100 text-teal-700 text-sm font-bold">
            {index + 1}
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">
              {inst.title || `Site ${index + 1}`}
            </p>
            <p className="text-xs text-muted-foreground">
              {inst.videoUrl ? 'Video' : 'No video'} · {inst.notes ? 'Notes' : 'No notes'} · {(inst.mediaCsv ?? '').split(',').filter(Boolean).length} Media
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-red-500 hover:text-red-600 hover:bg-red-50"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            disabled={disabled}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <div className="border-t border-border bg-muted/10 p-4 space-y-4">
          <div>
            <FieldLabel label="Site name / label" hint="E.g., Alibaug – Site 1" />
            <Input
              value={inst.title}
              onChange={(e) => onChange({ ...inst, title: e.target.value })}
              placeholder="Site 1"
              disabled={disabled}
            />
          </div>
          <MediaUploadField
            label="Installation video"
            hint="Upload the primary installation video"
            value={inst.videoUrl}
            onChange={(url) => onChange({ ...inst, videoUrl: url })}
            bucket="deployments-media"
            folder="installations"
            mediaType="video"
            disabled={disabled}
          />
          <div>
            <FieldLabel label="Field notes" hint="Detailed observations and challenges" />
            <Textarea
              value={inst.notes}
              onChange={(e) => onChange({ ...inst, notes: e.target.value })}
              placeholder="Describe the site and installation process..."
              className="min-h-[140px]"
              disabled={disabled}
            />
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <FieldLabel label="Additional Media" hint="Images or videos below these notes" />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  const csv = inst.mediaCsv ?? '';
                  const updated = csv.trim() === '' ? ' ' : csv + ', ';
                  onChange({ ...inst, mediaCsv: updated });
                }}
                disabled={disabled}
                className="text-teal-700 border-teal-300"
              >
                <Plus className="h-3 w-3 mr-1" /> Add media
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {(inst.mediaCsv ?? '').split(',').map(s => s.trim()).filter(u => u !== undefined).map((url, i, arr) => (
                url !== undefined && (
                  <div key={i} className="relative rounded-xl border border-dashed border-teal-100 p-3 bg-white/50">
                    <div className="flex justify-end mb-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0 text-red-500"
                        onClick={() => {
                          const next = arr.filter((_, idx) => idx !== i).join(', ');
                          onChange({ ...inst, mediaCsv: next });
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                    <MediaUploadField
                      label=""
                      value={url}
                      onChange={(newUrl) => {
                        const next = [...arr];
                        next[i] = newUrl;
                        onChange({ ...inst, mediaCsv: next.join(', ') });
                      }}
                      bucket="deployments-media"
                      folder="field-notes"
                      mediaType="any"
                      disabled={disabled}
                    />
                  </div>
                )
              ))}
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── Gallery item ─────────────────────────────────────────────────────────────

function GalleryItem({
  url,
  index,
  onChange,
  onRemove,
  disabled,
}: {
  url: string;
  index: number;
  onChange: (url: string) => void;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <MediaUploadField
        label={`Photo ${index + 1}`}
        value={url}
        onChange={onChange}
        bucket="deployments-media"
        folder="gallery"
        mediaType="image"
        disabled={disabled}
      />
      <div className="flex justify-end p-2 pt-0">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="text-red-500 hover:text-red-600 hover:bg-red-50 text-xs"
          onClick={onRemove}
          disabled={disabled}
        >
          <Trash2 className="mr-1 h-3 w-3" /> Remove
        </Button>
      </div>
    </Card>
  );
}

// ─── Deployment editor card ───────────────────────────────────────────────────

type DeploymentData = {
  heading: string;
  intro: string;
  summary: string;
  summaryMediaCsv?: string;
  interviewVideoUrl: string;
  installations: Installation[];
  gallery: string[];
  previewVideoUrl: string;
  previewImages: string[];
};

function parseDeploymentData(raw: Record<string, unknown>): DeploymentData {
  const installations: Installation[] = Array.isArray(raw.installations)
    ? (raw.installations as Installation[]).map((x) => ({
      title: String(x?.title ?? ''),
      videoUrl: String(x?.videoUrl ?? ''),
      notes: String(x?.notes ?? ''),
      mediaCsv: String(x?.mediaCsv ?? ''),
    }))
    : [];
  const gallery: string[] = Array.isArray(raw.gallery)
    ? (raw.gallery as string[]).filter((x) => typeof x === 'string')
    : [];
  const previewImages: string[] = Array.isArray(raw.previewImages)
    ? (raw.previewImages as string[]).filter((x) => typeof x === 'string')
    : [];
  return {
    heading: String(raw.heading ?? ''),
    intro: String(raw.intro ?? ''),
    summary: String(raw.summary ?? ''),
    summaryMediaCsv: String(raw.summaryMediaCsv ?? ''),
    interviewVideoUrl: String(raw.interviewVideoUrl ?? ''),
    installations,
    gallery,
    previewVideoUrl: String(raw.previewVideoUrl ?? ''),
    previewImages,
  };
}

function DeploymentEditor({
  record,
  onSave,
  onDelete,
  saving,
  deleting,
  isFirst,
}: {
  record: DeploymentRecord;
  onSave: (slug: string, title: string, data: DeploymentData) => void;
  onDelete: (slug: string) => void;
  saving: boolean;
  deleting: boolean;
  isFirst: boolean;
}) {
  const [open, setOpen] = useState(isFirst);
  const [title, setTitle] = useState(record.title);
  const [data, setData] = useState<DeploymentData>(() => parseDeploymentData(record.data));
  const dirty = true;

  const busy = saving || deleting;

  function updateInstallation(idx: number, updated: Installation) {
    const next = [...data.installations];
    next[idx] = updated;
    setData({ ...data, installations: next });
  }

  function removeInstallation(idx: number) {
    setData({ ...data, installations: data.installations.filter((_, i) => i !== idx) });
  }

  function addInstallation() {
    setData((d) => ({
      ...d,
      installations: [...d.installations, { title: '', videoUrl: '', notes: '', mediaCsv: '' }],
    }));
  }

  function updateGallery(idx: number, url: string) {
    const next = [...data.gallery];
    next[idx] = url;
    setData({ ...data, gallery: next });
  }

  function removeGalleryItem(idx: number) {
    setData({ ...data, gallery: data.gallery.filter((_, i) => i !== idx) });
  }

  function addGalleryItem() {
    setData((d) => ({ ...d, gallery: [...d.gallery, ''] }));
  }

  function updatePreviewImage(idx: number, url: string) {
    const next = [...data.previewImages];
    next[idx] = url;
    setData({ ...data, previewImages: next });
  }

  function removePreviewImage(idx: number) {
    setData({ ...data, previewImages: data.previewImages.filter((_, i) => i !== idx) });
  }

  function addPreviewImage() {
    if (data.previewImages.length >= 4) {
      toast({ title: 'Max 4 preview images', description: 'Remove one before adding.' });
      return;
    }
    setData((d) => ({ ...d, previewImages: [...d.previewImages, ''] }));
  }

  return (
    <Card className="overflow-hidden">
      {/* Header */}
      <div
        className="flex cursor-pointer items-center justify-between gap-3 p-4"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl bg-teal-100">
            <MapPin className="h-5 w-5 text-teal-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{title || 'Untitled deployment'}</p>
            <p className="text-xs text-muted-foreground font-mono">{record.slug}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-red-500 hover:text-red-600 hover:bg-red-50"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Delete deployment "${record.title}"? This cannot be undone.`)) {
                onDelete(record.slug);
              }
            }}
            disabled={busy}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          {open ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
        </div>
      </div>

      {open && (
        <div className="border-t border-border bg-muted/5 p-5 space-y-6">
          {/* Basic info */}
          <div>
            <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">Basic info</h3>
            <div className="space-y-3">
              <div>
                <FieldLabel label="Deployment title" hint="E.g., Alibaug, Raigad" />
                <Input value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} placeholder="Deployment name" />
              </div>
              <div>
                <FieldLabel label="Page heading" hint="Large text shown at the top" />
                <Input value={data.heading} onChange={(e) => setData({ ...data, heading: e.target.value })} disabled={busy} placeholder="Heading" />
              </div>
              <div>
                <FieldLabel label="Intro text" hint="Short description under the heading" />
                <Textarea value={data.intro} onChange={(e) => setData({ ...data, intro: e.target.value })} disabled={busy} placeholder="Introduce this deployment…" className="min-h-[80px]" />
              </div>
              <div>
                <FieldLabel label="Deployment summary" hint="Full narrative about the site" />
                <Textarea value={data.summary} onChange={(e) => setData({ ...data, summary: e.target.value })} disabled={busy} placeholder="Describe the deployment in detail…" className="min-h-[140px]" />
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <FieldLabel label="Summary Media" hint="Images or videos below the summary text" />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const csv = data.summaryMediaCsv ?? '';
                      const updated = csv.trim() === '' ? ' ' : csv + ', ';
                      setData({ ...data, summaryMediaCsv: updated });
                    }}
                    disabled={busy}
                    className="text-teal-700 border-teal-300"
                  >
                    <Plus className="h-3 w-3 mr-1" /> Add media
                  </Button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {(data.summaryMediaCsv ?? '').split(',').map(s => s.trim()).filter(u => u !== undefined).map((url, i, arr) => (
                    url !== undefined && (
                      <div key={i} className="relative rounded-xl border border-dashed border-teal-100 p-3 bg-white/50">
                        <div className="flex justify-end mb-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-red-500"
                            onClick={() => {
                              const next = arr.filter((_, idx) => idx !== i).join(', ');
                              setData({ ...data, summaryMediaCsv: next });
                            }}
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </div>
                        <MediaUploadField
                          label=""
                          value={url}
                          onChange={(newUrl) => {
                            const next = [...arr];
                            next[i] = newUrl;
                            setData({ ...data, summaryMediaCsv: next.join(', ') });
                          }}
                          bucket="deployments-media"
                          folder="summary"
                          mediaType="any"
                          disabled={busy}
                        />
                      </div>
                    )
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Interview video */}
          <div>
            <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">Interview video</h3>
            <MediaUploadField
              label="Interview / overview video"
              hint="A short reel or interview from the field"
              value={data.interviewVideoUrl}
              onChange={(url) => setData({ ...data, interviewVideoUrl: url })}
              bucket="deployments-media"
              folder="interviews"
              mediaType="video"
              disabled={busy}
            />
          </div>

          {/* Installation sites */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Installation sites</h3>
                <p className="text-xs text-muted-foreground">Add one card per site — each has a video and field notes.</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addInstallation}
                disabled={busy}
                className="text-teal-700 border-teal-300 hover:bg-teal-50"
              >
                <Plus className="mr-1 h-3 w-3" /> Add site
              </Button>
            </div>
            {data.installations.length === 0 && (
              <div className="rounded-xl border-2 border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No installation sites yet. Click "Add site" to begin.
              </div>
            )}
            <div className="space-y-3">
              {data.installations.map((inst, idx) => (
                <InstallationCard
                  key={idx}
                  inst={inst}
                  index={idx}
                  onChange={(u) => updateInstallation(idx, u)}
                  onRemove={() => removeInstallation(idx)}
                  disabled={busy}
                />
              ))}
            </div>
          </div>

          {/* Photo gallery */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Photo gallery</h3>
                <p className="text-xs text-muted-foreground">Add as many photos as you want — shown in a grid on the page.</p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={addGalleryItem}
                disabled={busy}
                className="text-teal-700 border-teal-300 hover:bg-teal-50"
              >
                <Plus className="mr-1 h-3 w-3" /> Add photo
              </Button>
            </div>
            {data.gallery.length === 0 && (
              <div className="rounded-xl border-2 border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No photos yet. Click "Add photo" to upload gallery images.
              </div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              {data.gallery.map((url, idx) => (
                <GalleryItem
                  key={idx}
                  url={url}
                  index={idx}
                  onChange={(u) => updateGallery(idx, u)}
                  onRemove={() => removeGalleryItem(idx)}
                  disabled={busy}
                />
              ))}
            </div>
          </div>

          {/* Home page preview media */}
          <div>
            <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">Home page preview</h3>
            <p className="mb-3 text-xs text-muted-foreground">The video and photos shown in the "Deployments" section on the Home page.</p>
            <div className="space-y-4">
              <MediaUploadField
                label="Preview video"
                hint="Short collage reel shown on the Home page"
                value={data.previewVideoUrl}
                onChange={(url) => setData({ ...data, previewVideoUrl: url })}
                bucket="deployments-media"
                folder="preview"
                mediaType="video"
                disabled={busy}
              />
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <FieldLabel label={`Preview photos (${data.previewImages.length}/4)`} hint="Up to 4 images shown beside the video on Home" />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={addPreviewImage}
                    disabled={busy || data.previewImages.length >= 4}
                    className="text-teal-700 border-teal-300 hover:bg-teal-50"
                  >
                    <Plus className="mr-1 h-3 w-3" /> Add
                  </Button>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {data.previewImages.map((url, idx) => (
                    <div key={idx} className="space-y-1">
                      <MediaUploadField
                        label={`Preview photo ${idx + 1}`}
                        value={url}
                        onChange={(u) => updatePreviewImage(idx, u)}
                        bucket="deployments-media"
                        folder="preview"
                        mediaType="image"
                        disabled={busy}
                      />
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-red-500 hover:text-red-600 hover:bg-red-50 text-xs"
                          onClick={() => removePreviewImage(idx)}
                          disabled={busy}
                        >
                          <Trash2 className="mr-1 h-3 w-3" /> Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Save */}
          <div className="flex justify-end gap-3 border-t border-border pt-4">
            <Button
              onClick={() => onSave(record.slug, title, data)}
              disabled={busy}
              className="bg-teal-600 hover:bg-teal-700 text-white"
            >
              {saving ? 'Saving…' : 'Save deployment'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ─── New deployment modal ─────────────────────────────────────────────────────

function NewDeploymentForm({
  onAdd,
  onClose,
  busy,
}: {
  onAdd: (slug: string, title: string) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState('');
  const slug = title.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');

  return (
    <Card className="p-5 border-2 border-teal-200 bg-teal-50/30">
      <div className="mb-4 flex items-center justify-between">
        <p className="font-semibold text-foreground">New deployment</p>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="space-y-3">
        <div>
          <FieldLabel label="Deployment name" hint="E.g., Pune, Maharashtra" />
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Village, District"
            disabled={busy}
            autoFocus
          />
        </div>
        <div>
          <p className="text-xs text-muted-foreground">
            URL slug: <span className="font-mono text-foreground">{slug || '…'}</span>
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => { if (slug && title) onAdd(slug, title); }}
            disabled={busy || !slug || !title}
            className="bg-teal-600 hover:bg-teal-700 text-white"
          >
            Create
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ─── Main admin page ──────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user, logOut } = useAuth();
  const queryClient = useQueryClient();
  const [activeSection, setActiveSection] = useState<AdminSection>(() => {
    const raw = sessionStorage.getItem('admin_active_section');
    if (!raw) return 'visibility';
    const allowed: AdminSection[] = [
      'visibility',
      'hero',
      'insights',
      'dashboard',
      'validation',
      'contact',
      'deployments-preview',
      'deployments-page',
      'partners',
      'devices',
      'surveys',
      'media',
    ];
    return (allowed as string[]).includes(raw) ? (raw as AdminSection) : 'visibility';
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showNewDeployment, setShowNewDeployment] = useState(false);
  const mainRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const prevHtmlOverflow = document.documentElement.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      document.documentElement.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, []);

  useEffect(() => {
    sessionStorage.setItem('admin_active_section', activeSection);
  }, [activeSection]);

  // Home content draft
  const [homeDraft, setHomeDraft] = useState<Record<string, unknown> | null>(null);
  const [partnersDraft, setPartnersDraft] = useState<Record<string, unknown> | null>(null);

  // Data queries
  const flagsQuery = useQuery({ queryKey: ['site_flags'], queryFn: fetchSiteFlags });
  const pagesQuery = useQuery({ queryKey: ['app_pages'], queryFn: fetchAppPages });
  const homeContentQuery = useQuery({ queryKey: ['site_content', 'home'], queryFn: () => fetchSiteContent('home') });
  const partnersContentQuery = useQuery({ queryKey: ['site_content', 'partners'], queryFn: () => fetchSiteContent('partners') });
  const deploymentsQuery = useQuery({ queryKey: ['all_deployments'], queryFn: fetchAllDeployments });
  const devicesQuery = useQuery({ queryKey: ['device_master_data'], queryFn: fetchAllDeviceMasterData });

  const flags = flagsQuery.data ?? {};
  const homeContent = mergeHomeContentWithDefaults(homeDraft ?? homeContentQuery.data ?? {}) as unknown as Record<string, unknown>;
  const homeDirty = homeDraft !== null;
  const partnersContent = mergePartnersContentWithDefaults(partnersDraft ?? partnersContentQuery.data ?? {});
  const partnersDirty = partnersDraft !== null;

  // Mutations
  const updateFlag = useMutation({
    mutationFn: ({ key, value }: { key: SiteFlagKey; value: boolean }) => setSiteFlag(key, value),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['site_flags'] }),
    onError: (err) => toast({ title: 'Error', description: errorMessage(err), variant: 'destructive' }),
  });

  const updatePageEnabled = useMutation({
    mutationFn: ({ path, enabled }: { path: string; enabled: boolean }) => setAppPageEnabled(path, enabled),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['app_pages'] }),
    onError: (err) => toast({ title: 'Error', description: errorMessage(err), variant: 'destructive' }),
  });

  const saveHomeContent = useMutation({
    mutationFn: (data: Record<string, unknown>) => setSiteContent('home', data),
    onSuccess: async () => {
      setHomeDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['site_content', 'home'] });
      toast({ title: 'Home content saved' });
    },
    onError: (err) => toast({ title: 'Save failed', description: errorMessage(err), variant: 'destructive' }),
  });

  const savePartnersContent = useMutation({
    mutationFn: (data: Record<string, unknown>) => setSiteContent('partners', data),
    onSuccess: async () => {
      setPartnersDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['site_content', 'partners'] });
      toast({ title: 'Partners content saved' });
    },
    onError: (err) => toast({ title: 'Save failed', description: errorMessage(err), variant: 'destructive' }),
  });

  const saveDeploymentMut = useMutation({
    mutationFn: ({ slug, title, data }: { slug: string; title: string; data: DeploymentData }) =>
      setDeployment(slug, { title, data: data as unknown as Record<string, unknown> }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['all_deployments'] });
      toast({ title: 'Deployment saved' });
    },
    onError: (err) => toast({ title: 'Save failed', description: errorMessage(err), variant: 'destructive' }),
  });

  const deleteDeploymentMut = useMutation({
    mutationFn: (slug: string) => deleteDeployment(slug),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['all_deployments'] });
      toast({ title: 'Deployment deleted' });
    },
    onError: (err) => toast({ title: 'Delete failed', description: errorMessage(err), variant: 'destructive' }),
  });

  const saveDeviceMut = useMutation({
    mutationFn: (patch: Parameters<typeof upsertDeviceMasterData>[0]) => upsertDeviceMasterData(patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['device_master_data'] });
      toast({ title: 'Device saved' });
    },
    onError: (err) => toast({ title: 'Save failed', description: errorMessage(err), variant: 'destructive' }),
  });

  const deleteDeviceMut = useMutation({
    mutationFn: (deviceId: string) => deleteDeviceMasterData(deviceId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['device_master_data'] });
      toast({ title: 'Device removed' });
    },
    onError: (err) => toast({ title: 'Delete failed', description: errorMessage(err), variant: 'destructive' }),
  });

  const createDeploymentMut = useMutation({
    mutationFn: ({ slug, title }: { slug: string; title: string }) =>
      setDeployment(slug, { title, data: {} }),
    onSuccess: async () => {
      setShowNewDeployment(false);
      await queryClient.invalidateQueries({ queryKey: ['all_deployments'] });
      toast({ title: 'Deployment created', description: 'Fill in the details below.' });
    },
    onError: (err) => toast({ title: 'Create failed', description: errorMessage(err), variant: 'destructive' }),
  });

  const isBusy =
    flagsQuery.isLoading || pagesQuery.isLoading || homeContentQuery.isLoading ||
    deploymentsQuery.isLoading || updateFlag.isPending || updatePageEnabled.isPending ||
    saveHomeContent.isPending || devicesQuery.isLoading || saveDeviceMut.isPending || deleteDeviceMut.isPending;

  const userLabel = useMemo(() => user?.email ?? user?.id ?? 'Admin', [user]);

  // ── Home content helpers ──────────────────────────────────────────────────
  function heroField(field: string) {
    return String((homeContent.hero as Record<string, unknown>)?.[field] ?? '');
  }
  function setHeroField(field: string, value: string) {
    setHomeDraft({ ...homeContent, hero: { ...(homeContent.hero as Record<string, unknown>), [field]: value } });
  }

  function dashField(field: string) {
    return (homeContent.dashboard as Record<string, unknown>)?.[field];
  }
  function setDashField(field: string, value: unknown) {
    setHomeDraft({ ...homeContent, dashboard: { ...(homeContent.dashboard as Record<string, unknown>), [field]: value } });
  }

  function insightsField(field: string) {
    return (homeContent.insights as Record<string, unknown>)?.[field];
  }
  function setInsightsField(field: string, value: unknown) {
    setHomeDraft({ ...homeContent, insights: { ...(homeContent.insights as Record<string, unknown>), [field]: value } });
  }

  function validationField(field: string) {
    return (homeContent.validation as Record<string, unknown>)?.[field];
  }
  function setValidationField(field: string, value: unknown) {
    setHomeDraft({ ...homeContent, validation: { ...(homeContent.validation as Record<string, unknown>), [field]: value } });
  }

  function contactField(field: string) {
    return (homeContent.contact as Record<string, unknown>)?.[field];
  }
  function setContactField(field: string, value: unknown) {
    setHomeDraft({ ...homeContent, contact: { ...(homeContent.contact as Record<string, unknown>), [field]: value } });
  }
  function contactFormField(field: string) {
    return ((homeContent.contact as Record<string, unknown>)?.form as Record<string, unknown>)?.[field];
  }
  function setContactFormField(field: string, value: unknown) {
    const current = (homeContent.contact as Record<string, unknown>) ?? {};
    const form = (current.form as Record<string, unknown>) ?? {};
    setHomeDraft({ ...homeContent, contact: { ...current, form: { ...form, [field]: value } } });
  }

  const kpiStats: Array<{ label: string; value: string; note: string }> = Array.isArray(dashField('stats'))
    ? (dashField('stats') as Array<{ label: string; value: string; note: string }>)
    : [];
  const alertItems: Array<{ tone: string; text: string }> = Array.isArray(dashField('alerts'))
    ? (dashField('alerts') as Array<{ tone: string; text: string }>)
    : [];
  const mapChips: string[] = Array.isArray(dashField('mapChips'))
    ? (dashField('mapChips') as string[])
    : [];
  const impactMetrics: Array<{ label: string; value: string; note: string }> = Array.isArray(dashField('impactMetrics'))
    ? (dashField('impactMetrics') as Array<{ label: string; value: string; note: string }>)
    : [];
  const actionableInsights: Array<{ title: string; description: string }> = Array.isArray(dashField('actionableInsights'))
    ? (dashField('actionableInsights') as Array<{ title: string; description: string }>)
    : [];
  const graphCards: Array<{ title: string; description: string; imageUrl?: string }> = Array.isArray(dashField('graphCards'))
    ? (dashField('graphCards') as Array<{ title: string; description: string; imageUrl?: string }>)
    : [];

  const insightsCards: Array<{ title: string; description: string; icon?: string }> = Array.isArray(insightsField('cards'))
    ? (insightsField('cards') as Array<{ title: string; description: string; icon?: string }>)
    : [];

  const validationCards: Array<{ title: string; detail: string }> = Array.isArray(validationField('cards'))
    ? (validationField('cards') as Array<{ title: string; detail: string }>)
    : [];
  const testimonials: Array<{ name: string; role: string; quote: string }> = Array.isArray(validationField('testimonials'))
    ? (validationField('testimonials') as Array<{ name: string; role: string; quote: string }>)
    : [];

  const pilotNeedsItems: string[] = Array.isArray(contactField('pilotNeedsItems'))
    ? (contactField('pilotNeedsItems') as string[])
    : [];
  const interestOptions: string[] = Array.isArray(contactFormField('interestOptions'))
    ? (contactFormField('interestOptions') as string[])
    : [];

  // ── Navigate helper ───────────────────────────────────────────────────────
  function navigate(section: AdminSection) {
    setActiveSection(section);
    setSidebarOpen(false);
    mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="admin-panel flex h-screen overflow-hidden bg-gray-50">
      <style>
        {`
          .admin-panel button:hover {
            color: black !important;
          }
        `}
      </style>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-64 flex-col bg-[#0f3d3a] text-white transition-transform duration-200 lg:relative lg:translate-x-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* Sidebar header */}
        <div className="flex items-center gap-3 border-b border-white/10 px-4 py-4">
          <img src="/logo.jpeg" alt="JalYantra" className="h-10 w-10 rounded-xl object-cover ring-2 ring-teal-400/40" />
          <div>
            <p className="text-sm font-bold text-white">JalYantra</p>
            <p className="text-xs text-teal-300">Admin Panel</p>
          </div>
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {SIDEBAR_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                onClick={() => navigate(item.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors',
                  active
                    ? 'bg-teal-500/20 text-teal-200'
                    : 'text-white/70 hover:bg-white/10 hover:text-white',
                )}
              >
                <Icon className={cn('h-4 w-4 flex-shrink-0', active ? 'text-teal-300' : 'text-white/50')} />
                <div>
                  <p className={cn('text-xs font-semibold', active ? 'text-teal-200' : 'text-white/80')}>{item.label}</p>
                  <p className="text-[10px] text-white/40">{item.desc}</p>
                </div>
              </button>
            );
          })}
        </nav>

        {/* Sidebar footer */}
        <div className="border-t border-white/10 p-3 space-y-2">
          <div className="px-3 py-1">
            <p className="text-xs text-white/50">Signed in as</p>
            <p className="truncate text-xs font-medium text-white/80">{userLabel}</p>
          </div>
          <button
            onClick={() => window.location.assign('/')}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-white/60 hover:bg-white/10 hover:text-white transition-colors"
          >
            <ExternalLink className="h-3.5 w-3.5" /> View site
          </button>
          <button
            onClick={logOut}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-white/60 hover:bg-white/10 hover:text-white transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" /> Log out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex items-center gap-3 border-b border-border bg-white px-4 py-3 shadow-sm">
          <button
            className="lg:hidden text-muted-foreground hover:text-foreground"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex-1">
            <p className="text-sm font-semibold text-foreground">
              {SIDEBAR_ITEMS.find((s) => s.id === activeSection)?.label}
            </p>
          </div>
          <Badge variant="outline" className="text-xs font-mono hidden sm:flex">
            {userLabel}
          </Badge>
        </header>

        {/* Scrollable content */}
        <main ref={mainRef} className="flex-1 overflow-y-auto p-4 md:p-6 lg:p-8">
          <div className="mx-auto max-w-3xl">

            {/* ── Section: Visibility & Pages ─────────────────────────────── */}
            {activeSection === 'visibility' && (
              <div>
                <SectionHeader
                  title="Visibility & Pages"
                  desc="Control which sections visitors see on the Home page, and enable or disable entire routes."
                />

                {/* Section toggles */}
                <Card className="mb-5 p-5">
                  <p className="mb-1 text-sm font-semibold text-foreground">Home page sections</p>
                  <p className="mb-4 text-xs text-muted-foreground">Toggle sections on or off for visitors. Changes save instantly.</p>
                  <div className="space-y-4">
                    {FLAG_DEFS.map((def) => (
                      <div key={def.key} className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium text-foreground">{def.label}</p>
                          <p className="text-xs text-muted-foreground">{def.description}</p>
                        </div>
                        <Switch
                          checked={!!(flags[def.key])}
                          onCheckedChange={(checked) => updateFlag.mutate({ key: def.key, value: checked })}
                          disabled={isBusy}
                          className="data-[state=checked]:bg-teal-600"
                        />
                      </div>
                    ))}
                  </div>
                </Card>

                {/* Pages */}
                <Card className="p-5">
                  <p className="mb-1 text-sm font-semibold text-foreground">Pages / Routes</p>
                  <p className="mb-4 text-xs text-muted-foreground">Enable or disable entire pages on the site.</p>
                  <div className="space-y-3">
                    {(pagesQuery.data ?? []).map((page) => (
                      <div key={page.path} className="flex items-center justify-between gap-4 rounded-xl border border-border bg-muted/20 px-4 py-3">
                        <div>
                          <p className="text-sm font-medium text-foreground">{page.title}</p>
                          <p className="font-mono text-xs text-muted-foreground">{page.path}</p>
                        </div>
                        <div className="flex items-center gap-2">
                          {page.path === '/admin' && (
                            <Badge variant="secondary" className="text-xs">Protected</Badge>
                          )}
                          <Switch
                            checked={page.is_enabled}
                            onCheckedChange={(checked) => updatePageEnabled.mutate({ path: page.path, enabled: checked })}
                            disabled={isBusy || page.path === '/admin'}
                            className="data-[state=checked]:bg-teal-600"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    The Admin route cannot be disabled to avoid locking you out.
                  </p>
                </Card>
              </div>
            )}

            {/* ── Section: Hero ──────────────────────────────────────────── */}
            {activeSection === 'hero' && (
              <div>
                <SectionHeader
                  title="Hero Section"
                  desc="Edit the headline, taglines, button labels, and logo shown at the very top of the Home page."
                />
                <Card className="p-5 space-y-5">
                  <div>
                    <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">Text content</h3>
                    <div className="space-y-3">
                      <div>
                        <FieldLabel label="Kicker" hint="Small badge above the headline, e.g., 'Smarter monitoring'" />
                        <Input value={heroField('kicker')} onChange={(e) => setHeroField('kicker', e.target.value)} disabled={isBusy} placeholder="Smarter monitoring" />
                      </div>
                      <div>
                        <FieldLabel label="Headline" hint="The main large title" />
                        <Input value={heroField('title')} onChange={(e) => setHeroField('title', e.target.value)} disabled={isBusy} placeholder="Smarter groundwater monitoring for rural India" />
                      </div>
                      <div>
                        <FieldLabel label="Description" hint="One or two sentences below the headline" />
                        <Textarea value={heroField('description')} onChange={(e) => setHeroField('description', e.target.value)} disabled={isBusy} placeholder="JalYantra is an IoT groundwater monitoring system…" className="min-h-[80px]" />
                      </div>
                      <div>
                        <FieldLabel label="Problem statement" hint="The 'Problem:' line in the hero" />
                        <Input value={heroField('problem')} onChange={(e) => setHeroField('problem', e.target.value)} disabled={isBusy} placeholder="Lack of continuous, local-level groundwater monitoring…" />
                      </div>
                      <div>
                        <FieldLabel label="Solution statement" hint="The 'Solution:' line in the hero" />
                        <Input value={heroField('solution')} onChange={(e) => setHeroField('solution', e.target.value)} disabled={isBusy} placeholder="LIDAR-based measurement with real-time dashboard…" />
                      </div>
                      <div />
                      <div>
                        <div className="mb-3">
                          <FieldLabel label="Carousel Media" hint="Add images or videos to the hero carousel" />
                        </div>

                        {(() => {
                          const csv = String(heroField('carouselMediaCsv') ?? '');
                          const urls = csv === '' ? [] : csv.split(',').map(u => u.trim());

                          return (
                            <div className="grid gap-4 md:grid-cols-2">
                              {urls.map((url, idx) => (
                                <div key={idx} className="relative rounded-2xl border-2 border-dashed border-teal-100 p-4 bg-teal-50/10">
                                  <div className="flex items-center justify-between mb-3">
                                    <span className="text-xs font-bold uppercase tracking-wider text-teal-600">Media Item {idx + 1}</span>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 rounded-full"
                                      onClick={() => {
                                        const updated = urls.filter((_, i) => i !== idx);
                                        setHeroField('carouselMediaCsv', updated.join(', '));
                                      }}
                                      disabled={isBusy}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>

                                  <MediaUploadField
                                    label=""
                                    value={url.split('|')[0]}
                                    onChange={(u) => {
                                      const parts = url.split('|');
                                      const thumb = parts[1] ? `|${parts[1]}` : '';
                                      const next = urls.map((x, i) => i === idx ? `${u}${thumb}` : x);
                                      setHeroField('carouselMediaCsv', next.join(', '));
                                    }}
                                    onThumbnail={(thumbUrl) => {
                                      const videoUrl = url.split('|')[0];
                                      const next = urls.map((x, i) => i === idx ? `${videoUrl}|${thumbUrl}` : x);
                                      setHeroField('carouselMediaCsv', next.join(', '));
                                    }}
                                    bucket="site-media"
                                    folder="hero"
                                    mediaType="video"
                                    disabled={isBusy}
                                  />
                                </div>
                              ))}

                              <button
                                type="button"
                                onClick={() => {
                                  const current = urls.length > 0 ? csv + ", " : " ";
                                  setHeroField('carouselMediaCsv', current);
                                }}
                                disabled={isBusy}
                                className="flex flex-col items-center justify-center gap-3 h-[200px] rounded-2xl border-2 border-dashed border-teal-200 bg-teal-50/20 text-teal-600 hover:bg-teal-50 hover:border-teal-400 hover:text-teal-700 transition-all group"
                              >
                                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-teal-100 group-hover:bg-teal-200 transition-colors">
                                  <Plus className="h-6 w-6" />
                                </div>
                                <span className="text-sm font-bold uppercase tracking-widest">Add Hero Media</span>
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  </div>


                  <div>
                    <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">Buttons</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Primary button text" hint="Button label (e.g., Go to Dashboard)" />
                        <Input value={heroField('primaryCta')} onChange={(e) => setHeroField('primaryCta', e.target.value)} disabled={isBusy} placeholder="Go to Dashboard" />
                      </div>
                      <div>
                        <FieldLabel label="Primary button link" hint="Internal path or URL (e.g., /dashboard)" />
                        <Input value={heroField('primaryCtaHref')} onChange={(e) => setHeroField('primaryCtaHref', e.target.value)} disabled={isBusy} placeholder="/dashboard" />
                      </div>
                      <div>
                        <FieldLabel label="Secondary button text" hint="Button label (e.g., Learn how it works)" />
                        <Input value={heroField('secondaryCta')} onChange={(e) => setHeroField('secondaryCta', e.target.value)} disabled={isBusy} placeholder="Learn how it works" />
                      </div>
                      <div>
                        <FieldLabel label="Secondary button link" hint="Use a section anchor like #how-it-works, or a URL" />
                        <Input value={heroField('secondaryCtaHref')} onChange={(e) => setHeroField('secondaryCtaHref', e.target.value)} disabled={isBusy} placeholder="#how-it-works" />
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">Logo</h3>
                    <MediaUploadField
                      label="Hero logo image"
                      hint="Replaces the default JalYantra logo shown in the hero area"
                      value={heroField('logoUrl')}
                      onChange={(url) => setHeroField('logoUrl', url)}
                      bucket="site-media"
                      folder="hero"
                      mediaType="image"
                      disabled={isBusy}
                    />
                  </div>
                </Card>
                <SaveBar
                  onSave={() => saveHomeContent.mutate(homeContent as unknown as Record<string, unknown>)}
                  onReset={() => setHomeDraft(null)}
                  saving={saveHomeContent.isPending}
                  dirty={homeDirty}
                />
              </div>
            )}

            {/* ── Section: Insights ──────────────────────────────────────── */}
            {activeSection === 'insights' && (
              <div>
                <SectionHeader
                  title="Insights Section"
                  desc="Edit the section intro and the four insight cards shown under 'How it works' on the Home page."
                />

                <div className="space-y-5">
                  <Card className="p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Section intro</h3>
                    <div>
                      <FieldLabel label="Kicker (small label)" />
                      <Input
                        value={String(insightsField('kicker') ?? '')}
                        onChange={(e) => setInsightsField('kicker', e.target.value)}
                        disabled={isBusy}
                        placeholder="Insights that drive action"
                      />
                    </div>
                    <div>
                      <FieldLabel label="Heading" />
                      <Input
                        value={String(insightsField('heading') ?? '')}
                        onChange={(e) => setInsightsField('heading', e.target.value)}
                        disabled={isBusy}
                        placeholder="Insights that turn into action"
                      />
                    </div>
                    <div>
                      <FieldLabel label="Description" />
                      <Textarea
                        value={String(insightsField('description') ?? '')}
                        onChange={(e) => setInsightsField('description', e.target.value)}
                        disabled={isBusy}
                        className="min-h-[80px]"
                      />
                    </div>
                  </Card>

                  <Card className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Insight cards</h3>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setInsightsField('cards', [...insightsCards, { title: '', description: '', icon: '' }])}
                        disabled={isBusy}
                      >
                        <Plus className="h-4 w-4 mr-2" /> Add card
                      </Button>
                    </div>

                    <div className="space-y-4">
                      {insightsCards.map((card, idx) => (
                        <Card key={`${card.title}-${idx}`} className="p-4 space-y-3 border border-border">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold text-foreground">Card {idx + 1}</p>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600 hover:bg-red-50"
                              onClick={() => setInsightsField('cards', insightsCards.filter((_, i) => i !== idx))}
                              disabled={isBusy}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <FieldLabel label="Title" />
                              <Input
                                value={card.title ?? ''}
                                onChange={(e) => setInsightsField('cards', insightsCards.map((c, i) => i === idx ? { ...c, title: e.target.value } : c))}
                                disabled={isBusy}
                              />
                            </div>
                            <MediaUploadField
                              label="Icon image"
                              hint="Optional; shown above the card"
                              value={String(card.icon ?? '')}
                              onChange={(url) => setInsightsField('cards', insightsCards.map((c, i) => i === idx ? { ...c, icon: url } : c))}
                              bucket="site-media"
                              folder="insights"
                              mediaType="image"
                              disabled={isBusy}
                              showManualUrl={false}
                            />
                          </div>

                          <div>
                            <FieldLabel label="Description" />
                            <Textarea
                              value={card.description ?? ''}
                              onChange={(e) => setInsightsField('cards', insightsCards.map((c, i) => i === idx ? { ...c, description: e.target.value } : c))}
                              disabled={isBusy}
                              className="min-h-[80px]"
                            />
                          </div>
                        </Card>
                      ))}
                    </div>
                  </Card>

                  <SaveBar
                    onSave={() => saveHomeContent.mutate(homeContent as unknown as Record<string, unknown>)}
                    onReset={() => setHomeDraft(null)}
                    saving={saveHomeContent.isPending}
                    dirty={homeDirty}
                  />
                </div>
              </div>
            )}

            {/* ── Section: Dashboard ─────────────────────────────────────── */}
            {activeSection === 'dashboard' && (
              <div>
                <SectionHeader
                  title="Dashboard Section"
                  desc="Edit the KPI cards, alerts, and interactive map card shown in the 'Dashboard' section of the Home page."
                />
                <div className="space-y-5">

                  {/* Heading */}
                  <Card className="p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Section intro</h3>
                    <div>
                      <FieldLabel label="Section heading" />
                      <Input value={String(dashField('heading') ?? '')} onChange={(e) => setDashField('heading', e.target.value)} disabled={isBusy} placeholder="What users see" />
                    </div>
                    <div>
                      <FieldLabel label="Section description" />
                      <Textarea value={String(dashField('description') ?? '')} onChange={(e) => setDashField('description', e.target.value)} disabled={isBusy} placeholder="A clean summary for quick decisions…" className="min-h-[80px]" />
                    </div>
                  </Card>

                  {/* KPI cards */}
                  <Card className="p-5">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">KPI cards</h3>
                        <p className="text-xs text-muted-foreground">The stats shown at the top of the dashboard section.</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDashField('stats', [...kpiStats, { label: '', value: '', note: '' }])}
                        disabled={isBusy}
                        className="text-teal-700 border-teal-300 hover:bg-teal-50"
                      >
                        <Plus className="mr-1 h-3 w-3" /> Add KPI
                      </Button>
                    </div>
                    {kpiStats.length === 0 && (
                      <div className="rounded-xl border-2 border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                        No KPI cards yet. Click "Add KPI" to create one.
                      </div>
                    )}
                    <div className="grid gap-3 md:grid-cols-2">
                      {kpiStats.map((stat, idx) => (
                        <Card key={idx} className="p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <Badge variant="outline" className="text-xs">KPI {idx + 1}</Badge>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600 h-6 w-6 p-0"
                              onClick={() => setDashField('stats', kpiStats.filter((_, i) => i !== idx))}
                              disabled={isBusy}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                          <div className="space-y-2">
                            <Input
                              placeholder="Label (e.g., Total Sensors)"
                              value={stat.label}
                              onChange={(e) => setDashField('stats', kpiStats.map((s, i) => i === idx ? { ...s, label: e.target.value } : s))}
                              disabled={isBusy}
                            />
                            <Input
                              placeholder="Value (e.g., 5)"
                              value={stat.value}
                              onChange={(e) => setDashField('stats', kpiStats.map((s, i) => i === idx ? { ...s, value: e.target.value } : s))}
                              disabled={isBusy}
                            />
                            <Input
                              placeholder="Note (e.g., Monitored locations)"
                              value={stat.note}
                              onChange={(e) => setDashField('stats', kpiStats.map((s, i) => i === idx ? { ...s, note: e.target.value } : s))}
                              disabled={isBusy}
                            />
                          </div>
                        </Card>
                      ))}
                    </div>
                  </Card>

                  {/* Alerts */}
                  <Card className="p-5">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Active alerts</h3>
                        <p className="text-xs text-muted-foreground">Alert messages shown in the dashboard preview.</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDashField('alerts', [...alertItems, { tone: 'danger', text: '' }])}
                        disabled={isBusy}
                        className="text-teal-700 border-teal-300 hover:bg-teal-50"
                      >
                        <Plus className="mr-1 h-3 w-3" /> Add alert
                      </Button>
                    </div>
                    {alertItems.length === 0 && (
                      <div className="rounded-xl border-2 border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                        No alerts yet. Click "Add alert" to create one.
                      </div>
                    )}
                    <div className="space-y-2">
                      {alertItems.map((alert, idx) => (
                        <div key={idx} className="flex items-center gap-2">
                          <Select
                            value={alert.tone}
                            onValueChange={(v) => setDashField('alerts', alertItems.map((a, i) => i === idx ? { ...a, tone: v } : a))}
                            disabled={isBusy}
                          >
                            <SelectTrigger className="w-[120px] flex-shrink-0">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="danger">Warning</SelectItem>
                              <SelectItem value="success">OK / Safe</SelectItem>
                            </SelectContent>
                          </Select>
                          <Input
                            className="flex-1"
                            placeholder="Alert message text"
                            value={alert.text}
                            onChange={(e) => setDashField('alerts', alertItems.map((a, i) => i === idx ? { ...a, text: e.target.value } : a))}
                            disabled={isBusy}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-red-500 hover:text-red-600 flex-shrink-0"
                            onClick={() => setDashField('alerts', alertItems.filter((_, i) => i !== idx))}
                            disabled={isBusy}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </Card>

                  {/* Map card */}
                  <Card className="p-5 space-y-4">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Interactive map card</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Map title" />
                        <Input value={String(dashField('mapTitle') ?? '')} onChange={(e) => setDashField('mapTitle', e.target.value)} disabled={isBusy} placeholder="Interactive Sensor Map" />
                      </div>
                      <div>
                        <FieldLabel label="Map subtitle" />
                        <Input value={String(dashField('mapSubtitle') ?? '')} onChange={(e) => setDashField('mapSubtitle', e.target.value)} disabled={isBusy} placeholder="Click markers for readings" />
                      </div>
                      <div>
                        <FieldLabel label="Badge text" />
                        <Input value={String(dashField('mapBadge') ?? '')} onChange={(e) => setDashField('mapBadge', e.target.value)} disabled={isBusy} placeholder="5 sensors" />
                      </div>
                    </div>
                    <MediaUploadField
                      label="Map background image"
                      hint="Upload a screenshot of the sensor map"
                      value={String(dashField('mapImageUrl') ?? '')}
                      onChange={(url) => setDashField('mapImageUrl', url)}
                      bucket="site-media"
                      folder="dashboard"
                      mediaType="image"
                      disabled={isBusy}
                    />

                    <div>
                      <div className="mb-2 flex items-center justify-between">
                        <FieldLabel label="Map layer chips" hint="Small labels shown on the map card (e.g., Layer: Sensor)" />
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => setDashField('mapChips', [...mapChips, ''])}
                          disabled={isBusy}
                          className="text-teal-700 border-teal-300 hover:bg-teal-50"
                        >
                          <Plus className="mr-1 h-3 w-3" /> Add chip
                        </Button>
                      </div>
                      <div className="space-y-2">
                        {mapChips.map((chip, idx) => (
                          <div key={idx} className="flex gap-2">
                            <Input
                              value={chip}
                              placeholder="Chip label"
                              onChange={(e) => setDashField('mapChips', mapChips.map((c, i) => i === idx ? e.target.value : c))}
                              disabled={isBusy}
                            />
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600"
                              onClick={() => setDashField('mapChips', mapChips.filter((_, i) => i !== idx))}
                              disabled={isBusy}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </Card>

                  {/* What users see — 4 preview graphs */}
                  <Card className="p-5">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">What users see — preview graphs</h3>
                        <p className="text-xs text-muted-foreground">
                          Four dashboard screenshots shown in the Home page Dashboard section. Upload the new graph images here.
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDashField('graphCards', [...graphCards, { title: '', description: '', imageUrl: '' }])}
                        disabled={isBusy || graphCards.length >= 4}
                        className="text-teal-700 border-teal-300 hover:bg-teal-50 hover:text-teal-900"
                      >
                        <Plus className="mr-1 h-3 w-3" /> Add graph
                      </Button>
                    </div>
                    {graphCards.length === 0 ? (
                      <div className="rounded-xl border-2 border-dashed border-border p-5 text-center text-sm text-muted-foreground">
                        No graph cards yet. Click &quot;Add graph&quot; to create up to four preview images.
                      </div>
                    ) : (
                      <div className="grid gap-4 md:grid-cols-2">
                        {graphCards.map((card, idx) => (
                          <Card key={idx} className="p-4 space-y-3">
                            <div className="flex items-center justify-between">
                              <Badge variant="outline" className="text-xs">Graph {idx + 1}</Badge>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                className="text-red-500 hover:text-red-600 h-6 w-6 p-0"
                                onClick={() => setDashField('graphCards', graphCards.filter((_, i) => i !== idx))}
                                disabled={isBusy}
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                            <Input
                              placeholder="Graph title"
                              value={card.title}
                              onChange={(e) =>
                                setDashField(
                                  'graphCards',
                                  graphCards.map((c, i) => (i === idx ? { ...c, title: e.target.value } : c)),
                                )
                              }
                              disabled={isBusy}
                            />
                            <Textarea
                              placeholder="Short description"
                              value={card.description}
                              onChange={(e) =>
                                setDashField(
                                  'graphCards',
                                  graphCards.map((c, i) => (i === idx ? { ...c, description: e.target.value } : c)),
                                )
                              }
                              disabled={isBusy}
                              rows={2}
                            />
                            <MediaUploadField
                              label="Graph image"
                              value={card.imageUrl ?? ''}
                              onChange={(url) =>
                                setDashField(
                                  'graphCards',
                                  graphCards.map((c, i) => (i === idx ? { ...c, imageUrl: url } : c)),
                                )
                              }
                              bucket="site-media"
                              folder="dashboard-graphs"
                              mediaType="image"
                              disabled={isBusy}
                            />
                          </Card>
                        ))}
                      </div>
                    )}
                  </Card>

                  <Card className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Impact metrics</h3>
                        <p className="text-xs text-muted-foreground">Editable cards used by the Home page Impact Metrics section.</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDashField('impactMetrics', [...impactMetrics, { label: '', value: '', note: '' }])}
                        disabled={isBusy}
                        className="text-teal-700 border-teal-300 hover:bg-teal-50"
                      >
                        <Plus className="mr-1 h-3 w-3" /> Add metric
                      </Button>
                    </div>
                    <div className="space-y-3">
                      {impactMetrics.map((metric, idx) => (
                        <Card key={idx} className="p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <Badge variant="outline" className="text-xs">Metric {idx + 1}</Badge>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600 h-6 w-6 p-0"
                              onClick={() => setDashField('impactMetrics', impactMetrics.filter((_, i) => i !== idx))}
                              disabled={isBusy}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                          <div className="grid gap-2 md:grid-cols-3">
                            <Input
                              placeholder="Label"
                              value={metric.label}
                              onChange={(e) => setDashField('impactMetrics', impactMetrics.map((m, i) => i === idx ? { ...m, label: e.target.value } : m))}
                              disabled={isBusy}
                            />
                            <Input
                              placeholder="Value"
                              value={metric.value}
                              onChange={(e) => setDashField('impactMetrics', impactMetrics.map((m, i) => i === idx ? { ...m, value: e.target.value } : m))}
                              disabled={isBusy}
                            />
                            <Input
                              placeholder="Note"
                              value={metric.note}
                              onChange={(e) => setDashField('impactMetrics', impactMetrics.map((m, i) => i === idx ? { ...m, note: e.target.value } : m))}
                              disabled={isBusy}
                            />
                          </div>
                        </Card>
                      ))}
                    </div>
                  </Card>

                  <Card className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Actionable insights</h3>
                        <p className="text-xs text-muted-foreground">Cards shown in the Home page Actionable Insights section.</p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setDashField('actionableInsights', [...actionableInsights, { title: '', description: '' }])}
                        disabled={isBusy}
                        className="text-teal-700 border-teal-300 hover:bg-teal-50"
                      >
                        <Plus className="mr-1 h-3 w-3" /> Add insight
                      </Button>
                    </div>
                    <div className="space-y-3">
                      {actionableInsights.map((item, idx) => (
                        <Card key={idx} className="p-3">
                          <div className="mb-2 flex items-center justify-between">
                            <Badge variant="outline" className="text-xs">Insight {idx + 1}</Badge>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600 h-6 w-6 p-0"
                              onClick={() => setDashField('actionableInsights', actionableInsights.filter((_, i) => i !== idx))}
                              disabled={isBusy}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                          <div className="space-y-2">
                            <Input
                              placeholder="Title"
                              value={item.title}
                              onChange={(e) => setDashField('actionableInsights', actionableInsights.map((a, i) => i === idx ? { ...a, title: e.target.value } : a))}
                              disabled={isBusy}
                            />
                            <Textarea
                              placeholder="Description"
                              value={item.description}
                              onChange={(e) => setDashField('actionableInsights', actionableInsights.map((a, i) => i === idx ? { ...a, description: e.target.value } : a))}
                              disabled={isBusy}
                              className="min-h-[70px]"
                            />
                          </div>
                        </Card>
                      ))}
                    </div>
                  </Card>
                </div>
                <SaveBar
                  onSave={() => saveHomeContent.mutate(homeContent as unknown as Record<string, unknown>)}
                  onReset={() => setHomeDraft(null)}
                  saving={saveHomeContent.isPending}
                  dirty={homeDirty}
                />
              </div>
            )}

            {/* ── Section: Validation ────────────────────────────────────── */}
            {activeSection === 'validation' && (
              <div>
                <SectionHeader
                  title="Validation Section"
                  desc="Edit the Validation section headings, cards, and testimonial placeholders on the Home page."
                />

                <div className="space-y-5">
                  <Card className="p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Section intro</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Kicker" />
                        <Input value={String(validationField('kicker') ?? '')} onChange={(e) => setValidationField('kicker', e.target.value)} disabled={isBusy} />
                      </div>
                      <div>
                        <FieldLabel label="Heading" />
                        <Input value={String(validationField('heading') ?? '')} onChange={(e) => setValidationField('heading', e.target.value)} disabled={isBusy} />
                      </div>
                    </div>
                    <div>
                      <FieldLabel label="Description" />
                      <Textarea
                        value={String(validationField('description') ?? '')}
                        onChange={(e) => setValidationField('description', e.target.value)}
                        disabled={isBusy}
                        className="min-h-[80px]"
                      />
                    </div>
                  </Card>

                  <Card className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Validation cards</h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Home page shows only: &quot;{IWA_DIGITAL_WATER_SUMMIT_CERTIFICATE_TITLE}&quot;
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setValidationField('cards', [...validationCards, { title: '', detail: '' }])}
                        disabled={isBusy}
                      >
                        <Plus className="h-4 w-4 mr-2" /> Add card
                      </Button>
                    </div>

                    <div className="space-y-4">
                      {validationCards.map((card, idx) => (
                        <Card key={`${card.title}-${idx}`} className="p-4 space-y-3 border border-border">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold text-foreground">Card {idx + 1}</p>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600 hover:bg-red-50"
                              onClick={() => setValidationField('cards', validationCards.filter((_, i) => i !== idx))}
                              disabled={isBusy}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="space-y-3">
                              <div>
                                <FieldLabel label="Title" />
                                <Input
                                  value={card.title ?? ''}
                                  onChange={(e) => setValidationField('cards', validationCards.map((c, i) => i === idx ? { ...c, title: e.target.value } : c))}
                                  disabled={isBusy}
                                />
                              </div>
                              <div>
                                <FieldLabel label="Detail" />
                                <Input
                                  value={card.detail ?? ''}
                                  onChange={(e) => setValidationField('cards', validationCards.map((c, i) => i === idx ? { ...c, detail: e.target.value } : c))}
                                  disabled={isBusy}
                                />
                              </div>
                            </div>
                            <MediaUploadField
                              label="Media File"
                              hint="PDF, Image, Video, Docx, or Drive Link"
                              value={card.mediaUrl ?? ''}
                              onChange={(url) => setValidationField('cards', validationCards.map((c, i) => i === idx ? { ...c, mediaUrl: url } : c))}
                              bucket="site-media"
                              folder="validation"
                              mediaType="any"
                              disabled={isBusy}
                            />
                          </div>
                        </Card>
                      ))}
                    </div>
                  </Card>

                  <Card className="p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Testimonials block</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Testimonials heading" />
                        <Input
                          value={String(validationField('testimonialsHeading') ?? '')}
                          onChange={(e) => setValidationField('testimonialsHeading', e.target.value)}
                          disabled={isBusy}
                        />
                      </div>
                      <div>
                        <FieldLabel label="Testimonials description" />
                        <Input
                          value={String(validationField('testimonialsDescription') ?? '')}
                          onChange={(e) => setValidationField('testimonialsDescription', e.target.value)}
                          disabled={isBusy}
                        />
                      </div>
                    </div>
                  </Card>

                  <Card className="p-5 space-y-4">
                    <div className="flex items-center justify-between gap-3">
                      <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Testimonials</h3>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => setValidationField('testimonials', [...testimonials, { name: '', role: '', quote: '' }])}
                        disabled={isBusy}
                      >
                        <Plus className="h-4 w-4 mr-2" /> Add testimonial
                      </Button>
                    </div>

                    <div className="space-y-4">
                      {testimonials.map((t, idx) => (
                        <Card key={`${t.name}-${idx}`} className="p-4 space-y-3 border border-border">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-sm font-semibold text-foreground">Testimonial {idx + 1}</p>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-red-500 hover:text-red-600 hover:bg-red-50"
                              onClick={() => setValidationField('testimonials', testimonials.filter((_, i) => i !== idx))}
                              disabled={isBusy}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <FieldLabel label="Name" />
                              <Input
                                value={t.name ?? ''}
                                onChange={(e) => setValidationField('testimonials', testimonials.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))}
                                disabled={isBusy}
                              />
                            </div>
                            <div>
                              <FieldLabel label="Role" />
                              <Input
                                value={t.role ?? ''}
                                onChange={(e) => setValidationField('testimonials', testimonials.map((x, i) => i === idx ? { ...x, role: e.target.value } : x))}
                                disabled={isBusy}
                              />
                            </div>
                          </div>

                          <div>
                            <FieldLabel label="Quote" />
                            <Textarea
                              value={t.quote ?? ''}
                              onChange={(e) => setValidationField('testimonials', testimonials.map((x, i) => i === idx ? { ...x, quote: e.target.value } : x))}
                              disabled={isBusy}
                              className="min-h-[80px]"
                            />
                          </div>
                        </Card>
                      ))}
                    </div>
                  </Card>

                  <SaveBar
                    onSave={() => saveHomeContent.mutate(homeContent as unknown as Record<string, unknown>)}
                    onReset={() => setHomeDraft(null)}
                    saving={saveHomeContent.isPending}
                    dirty={homeDirty}
                  />
                </div>
              </div>
            )}

            {/* ── Section: Contact ───────────────────────────────────────── */}
            {activeSection === 'contact' && (
              <div>
                <SectionHeader
                  title="Contact Section"
                  desc="Edit the 'Run a pilot with us' copy, pilot needs list, and contact form labels."
                />

                <div className="space-y-5">
                  <Card className="p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Section copy</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Kicker" />
                        <Input value={String(contactField('kicker') ?? '')} onChange={(e) => setContactField('kicker', e.target.value)} disabled={isBusy} />
                      </div>
                      <div>
                        <FieldLabel label="Heading" />
                        <Input value={String(contactField('heading') ?? '')} onChange={(e) => setContactField('heading', e.target.value)} disabled={isBusy} />
                      </div>
                    </div>
                    <div>
                      <FieldLabel label="Description" />
                      <Textarea
                        value={String(contactField('description') ?? '')}
                        onChange={(e) => setContactField('description', e.target.value)}
                        disabled={isBusy}
                        className="min-h-[80px]"
                      />
                    </div>
                  </Card>

                  <Card className="p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Pilot needs card</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Card heading" />
                        <Input value={String(contactField('pilotNeedsHeading') ?? '')} onChange={(e) => setContactField('pilotNeedsHeading', e.target.value)} disabled={isBusy} />
                      </div>
                      <div>
                        <FieldLabel label="Email label" />
                        <Input value={String(contactField('emailLabel') ?? '')} onChange={(e) => setContactField('emailLabel', e.target.value)} disabled={isBusy} />
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Email value" />
                        <Input value={String(contactField('emailValue') ?? '')} onChange={(e) => setContactField('emailValue', e.target.value)} disabled={isBusy} />
                      </div>
                      <div>
                        <FieldLabel label="Location label" />
                        <Input value={String(contactField('locationLabel') ?? '')} onChange={(e) => setContactField('locationLabel', e.target.value)} disabled={isBusy} />
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Location value" />
                        <Input value={String(contactField('locationValue') ?? '')} onChange={(e) => setContactField('locationValue', e.target.value)} disabled={isBusy} />
                      </div>
                      <div />
                    </div>
                    <div>
                      <FieldLabel label="Pilot needs list" hint="One item per line" />
                      <Textarea
                        value={pilotNeedsItems.join('\n')}
                        onChange={(e) => setContactField('pilotNeedsItems', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                        disabled={isBusy}
                        className="min-h-[110px] font-mono text-xs"
                      />
                    </div>
                  </Card>

                  <Card className="p-5 space-y-3">
                    <h3 className="text-xs font-bold uppercase tracking-widest text-muted-foreground">Form labels</h3>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Name placeholder" />
                        <Input value={String(contactFormField('namePlaceholder') ?? '')} onChange={(e) => setContactFormField('namePlaceholder', e.target.value)} disabled={isBusy} />
                      </div>
                      <div>
                        <FieldLabel label="Organization placeholder" />
                        <Input value={String(contactFormField('organizationPlaceholder') ?? '')} onChange={(e) => setContactFormField('organizationPlaceholder', e.target.value)} disabled={isBusy} />
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Email placeholder" />
                        <Input value={String(contactFormField('emailPlaceholder') ?? '')} onChange={(e) => setContactFormField('emailPlaceholder', e.target.value)} disabled={isBusy} />
                      </div>
                      <div>
                        <FieldLabel label="Interest placeholder" />
                        <Input value={String(contactFormField('interestPlaceholder') ?? '')} onChange={(e) => setContactFormField('interestPlaceholder', e.target.value)} disabled={isBusy} />
                      </div>
                    </div>
                    <div>
                      <FieldLabel label="Interest options" hint="One option per line" />
                      <Textarea
                        value={interestOptions.join('\n')}
                        onChange={(e) => setContactFormField('interestOptions', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
                        disabled={isBusy}
                        className="min-h-[90px] font-mono text-xs"
                      />
                    </div>
                    <div>
                      <FieldLabel label="Details placeholder" />
                      <Textarea
                        value={String(contactFormField('detailsPlaceholder') ?? '')}
                        onChange={(e) => setContactFormField('detailsPlaceholder', e.target.value)}
                        disabled={isBusy}
                        className="min-h-[80px]"
                      />
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Submit button label" />
                        <Input value={String(contactFormField('submitLabel') ?? '')} onChange={(e) => setContactFormField('submitLabel', e.target.value)} disabled={isBusy} />
                      </div>
                      <div>
                        <FieldLabel label="Sending label" />
                        <Input value={String(contactFormField('sendingLabel') ?? '')} onChange={(e) => setContactFormField('sendingLabel', e.target.value)} disabled={isBusy} />
                      </div>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                      <div>
                        <FieldLabel label="Required error message" />
                        <Input value={String(contactFormField('requiredErrorMessage') ?? '')} onChange={(e) => setContactFormField('requiredErrorMessage', e.target.value)} disabled={isBusy} />
                      </div>
                      <div>
                        <FieldLabel label="Sent message" />
                        <Input value={String(contactFormField('sentMessage') ?? '')} onChange={(e) => setContactFormField('sentMessage', e.target.value)} disabled={isBusy} />
                      </div>
                    </div>
                    <div>
                      <FieldLabel label="Generic error message" />
                      <Textarea
                        value={String(contactFormField('genericErrorMessage') ?? '')}
                        onChange={(e) => setContactFormField('genericErrorMessage', e.target.value)}
                        disabled={isBusy}
                        className="min-h-[80px]"
                      />
                    </div>
                  </Card>

                  <SaveBar
                    onSave={() => saveHomeContent.mutate(homeContent as unknown as Record<string, unknown>)}
                    onReset={() => setHomeDraft(null)}
                    saving={saveHomeContent.isPending}
                    dirty={homeDirty}
                  />
                </div>
              </div>
            )}


            {/* ── Section: Deployments Page ──────────────────────────────── */}
            {activeSection === 'deployments-page' && (
              <div>
                <SectionHeader
                  title="Deployments Page"
                  desc="Manage all entries shown on the /deployments page and customize the preview teaser on the Home page."
                />

                {/* Home Page Preview Settings */}
                <div className="mb-6">
                  <Card className="overflow-hidden border-teal-100 bg-teal-50/10">
                    <div className="bg-teal-50/50 p-4 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Home className="h-4 w-4 text-teal-600" />
                        <h3 className="text-sm font-bold text-teal-900">Home Page Section Settings</h3>
                      </div>
                      <p className="text-[10px] uppercase tracking-wider font-bold text-teal-600 bg-white px-2 py-0.5 rounded-full border border-teal-100">Global Settings</p>
                    </div>
                    <div className="p-5 space-y-4">
                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <FieldLabel label="Section heading" hint="Shown above the grid on Home" />
                          <Input
                            value={String((homeContent.deployments as Record<string, unknown>)?.heading ?? '')}
                            onChange={(e) => setHomeDraft({ ...homeContent, deployments: { ...(homeContent.deployments as Record<string, unknown>), heading: e.target.value } })}
                            disabled={isBusy}
                            placeholder="Deployments & NGO collaboration"
                          />
                        </div>
                        <div>
                          <FieldLabel label="Section description" hint="Short subtext on Home" />
                          <Textarea
                            value={String((homeContent.deployments as Record<string, unknown>)?.description ?? '')}
                            onChange={(e) => setHomeDraft({ ...homeContent, deployments: { ...(homeContent.deployments as Record<string, unknown>), description: e.target.value } })}
                            disabled={isBusy}
                            placeholder="Showcase installations, farmer trainings..."
                            className="min-h-[80px]"
                          />
                        </div>
                      </div>

                      <div className="pt-2 border-t border-teal-100/50">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <p className="text-sm font-semibold text-teal-900">Fallback Preview Media</p>
                            <p className="text-xs text-muted-foreground">Used if no individual deployment has "Home page preview" media set.</p>
                          </div>
                          <SaveBar
                            onSave={() => saveHomeContent.mutate(homeContent as unknown as Record<string, unknown>)}
                            onReset={() => setHomeDraft(null)}
                            saving={saveHomeContent.isPending}
                            dirty={homeDirty}
                            className="static p-0 bg-transparent border-none shadow-none"
                          />
                        </div>
                        <div className="space-y-4">
                          <MediaUploadField
                            label="Fallback video"
                            value={String((homeContent.deployments as Record<string, unknown>)?.previewVideoUrl ?? '')}
                            onChange={(url) => setHomeDraft({ ...homeContent, deployments: { ...(homeContent.deployments as Record<string, unknown>), previewVideoUrl: url } })}
                            bucket="deployments-media"
                            folder="preview"
                            mediaType="video"
                            disabled={isBusy}
                          />
                          <div>
                            <div className="mb-2 flex items-center justify-between">
                              <FieldLabel label="Fallback photos" />
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                  const imgs = Array.isArray((homeContent.deployments as Record<string, unknown>)?.previewImages)
                                    ? ((homeContent.deployments as Record<string, unknown>).previewImages as string[])
                                    : [];
                                  if (imgs.length < 4) {
                                    setHomeDraft({ ...homeContent, deployments: { ...(homeContent.deployments as Record<string, unknown>), previewImages: [...imgs, ''] } });
                                  }
                                }}
                                disabled={isBusy}
                                className="text-teal-700 border-teal-300"
                              >
                                <Plus className="mr-1 h-3 w-3" /> Add photo
                              </Button>
                            </div>
                            <div className="grid gap-3 md:grid-cols-2">
                              {(() => {
                                const imgs = Array.isArray((homeContent.deployments as Record<string, unknown>)?.previewImages)
                                  ? ((homeContent.deployments as Record<string, unknown>).previewImages as string[])
                                  : [];
                                return imgs.map((url, idx) => (
                                  <div key={idx} className="space-y-1">
                                    <MediaUploadField
                                      label=""
                                      value={url}
                                      onChange={(u) => {
                                        const next = imgs.map((x, i) => i === idx ? u : x);
                                        setHomeDraft({ ...homeContent, deployments: { ...(homeContent.deployments as Record<string, unknown>), previewImages: next } });
                                      }}
                                      bucket="deployments-media"
                                      folder="preview"
                                      mediaType="image"
                                      disabled={isBusy}
                                    />
                                    <div className="flex justify-end">
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="ghost"
                                        className="text-red-500 h-6 px-2 text-[10px]"
                                        onClick={() => setHomeDraft({ ...homeContent, deployments: { ...(homeContent.deployments as Record<string, unknown>), previewImages: imgs.filter((_, i) => i !== idx) } })}
                                        disabled={isBusy}
                                      >
                                        Remove
                                      </Button>
                                    </div>
                                  </div>
                                ));
                              })()}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </Card>
                </div>

                {/* Add new */}
                <div className="mb-4">
                  {showNewDeployment ? (
                    <NewDeploymentForm
                      onAdd={(slug, title) => createDeploymentMut.mutate({ slug, title })}
                      onClose={() => setShowNewDeployment(false)}
                      busy={createDeploymentMut.isPending}
                    />
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowNewDeployment(true)}
                      className="text-teal-700 border-teal-300 hover:bg-teal-50"
                    >
                      <Plus className="mr-2 h-4 w-4" /> Add new deployment
                    </Button>
                  )}
                </div>

                {deploymentsQuery.isLoading && (
                  <div className="py-12 text-center text-sm text-muted-foreground">Loading deployments…</div>
                )}

                {!deploymentsQuery.isLoading && (deploymentsQuery.data ?? []).length === 0 && (
                  <div className="rounded-xl border-2 border-dashed border-border p-10 text-center text-sm text-muted-foreground">
                    No deployments yet. Click "Add new deployment" above.
                  </div>
                )}

                <div className="space-y-4">
                  {(deploymentsQuery.data ?? []).map((record, idx) => (
                    <DeploymentEditor
                      key={record.slug}
                      record={record}
                      isFirst={idx === 0}
                      saving={saveDeploymentMut.isPending && saveDeploymentMut.variables?.slug === record.slug}
                      deleting={deleteDeploymentMut.isPending && deleteDeploymentMut.variables === record.slug}
                      onSave={(slug, title, data) => saveDeploymentMut.mutate({ slug, title, data })}
                      onDelete={(slug) => deleteDeploymentMut.mutate(slug)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Section: Master Data & Telemetry ────────────────────────── */}
            {activeSection === 'master-tables' && <MasterTablesSection />}

            {activeSection === 'surveys' && (
              <div className="space-y-6">
                <SectionHeader
                  title="Surveys"
                  desc="Push a survey's wells to the portable devices, sync their readings back, and mark surveys completed (drives the dashboard's Latest Survey Snapshot)."
                />
                <SurveyAdminSection />
              </div>
            )}

            {/* ── Section: Device Master Data ───────────────────────────── */}
            {activeSection === 'devices' && (
              <DeviceMasterSection
                devices={devicesQuery.data ?? []}
                masterLoading={devicesQuery.isLoading}
                busy={saveDeviceMut.isPending || deleteDeviceMut.isPending}
                onSave={(patch) => saveDeviceMut.mutate(patch)}
              />
            )}

            {activeSection === 'partners' && (
              <div>
                <SectionHeader
                  title="Partners Page"
                  desc="Upload the Krushi Vikas interview video and the four engagement photos shown on the Partners page."
                />
                <Card className="p-5 space-y-5">
                  <div className="flex items-center justify-between gap-3 border-b border-teal-100 pb-4">
                    <div>
                      <p className="text-sm font-semibold text-teal-900">Featured partner — Krushi Vikas</p>
                      <p className="text-xs text-muted-foreground">Media appears in the collapsible partner section on /partners</p>
                    </div>
                    <SaveBar
                      onSave={() => savePartnersContent.mutate(partnersContent as unknown as Record<string, unknown>)}
                      onReset={() => setPartnersDraft(null)}
                      saving={savePartnersContent.isPending}
                      dirty={partnersDirty}
                      className="static p-0 bg-transparent border-none shadow-none"
                    />
                  </div>

                  <MediaUploadField
                    label="Interview video"
                    hint="Shown in the top-right video panel beside the Krushi Vikas description"
                    value={partnersContent.featuredPartner.interviewVideoUrl}
                    onChange={(url) =>
                      setPartnersDraft({
                        ...partnersContent,
                        featuredPartner: { ...partnersContent.featuredPartner, interviewVideoUrl: url },
                      })
                    }
                    bucket="partners-media"
                    folder="krushi-vikas/video"
                    mediaType="video"
                    disabled={savePartnersContent.isPending}
                  />

                  <div className="space-y-3 border-t border-teal-100 pt-4">
                    <FieldLabel
                      label="Engagement photo gallery (4 slots)"
                      hint="2×2 grid beside “Engagement with JalYantra” on the Partners page"
                    />
                    <div className="grid gap-3 md:grid-cols-2">
                      {partnersContent.featuredPartner.galleryImages.map((url, idx) => (
                        <MediaUploadField
                          key={idx}
                          label={`Photo ${idx + 1}`}
                          value={url}
                          onChange={(nextUrl) => {
                            const galleryImages = partnersContent.featuredPartner.galleryImages.map((item, i) =>
                              i === idx ? nextUrl : item,
                            );
                            setPartnersDraft({
                              ...partnersContent,
                              featuredPartner: { ...partnersContent.featuredPartner, galleryImages },
                            });
                          }}
                          bucket="partners-media"
                          folder="krushi-vikas/gallery"
                          mediaType="image"
                          disabled={savePartnersContent.isPending}
                        />
                      ))}
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Run migration <code className="rounded bg-muted px-1">009_partners_page_content.sql</code> on Supabase if uploads fail (creates the partners-media bucket).
                  </p>
                </Card>
              </div>
            )}

            {/* ── Section: Media Upload ──────────────────────────────────── */}
            {activeSection === 'media' && (
              <div>
                <SectionHeader
                  title="Media Upload"
                  desc="Upload images, videos, and PDFs to the site media buckets. Copy the URL to use anywhere on the site."
                />
                <MediaLibrarySection />
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  );
}

// ─── Live devices — pump / non-pump control ───────────────────────────────────

type DeviceInstallType = 'pump' | 'non-pump';

function DeviceMasterSection({
  devices,
  masterLoading,
  busy,
  onSave,
}: {
  devices: DeviceMasterData[];
  masterLoading: boolean;
  busy: boolean;
  onSave: (patch: Parameters<typeof upsertDeviceMasterData>[0]) => void;
}) {
  const { sensors: liveSensors, isLoading: liveLoading, error: liveError, refresh } = useLiveDevices();
  const loading = masterLoading || liveLoading;

  const masterById = useMemo(() => new Map(devices.map((d) => [d.device_id, d])), [devices]);
  const liveById = useMemo(() => new Map(liveSensors.map((s) => [s.deviceId, s])), [liveSensors]);

  const deviceRows = useMemo(() => {
    const ids = new Set([...liveById.keys(), ...masterById.keys()]);
    return Array.from(ids)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((deviceId) => {
        const live = liveById.get(deviceId);
        const master = masterById.get(deviceId);
        const isPumpConnected = master ? master.is_pump_connected !== false : true;
        return {
          deviceId,
          district: live?.district ?? '—',
          depth: live?.depth,
          status: live?.status,
          isLive: Boolean(live),
          isPumpConnected,
          installType: (isPumpConnected ? 'pump' : 'non-pump') as DeviceInstallType,
          hasSavedFlag: Boolean(master),
        };
      });
  }, [liveById, masterById]);

  const handleInstallTypeChange = (deviceId: string, installType: DeviceInstallType) => {
    onSave({
      device_id: deviceId,
      is_pump_connected: installType === 'pump',
    });
  };

  return (
    <div>
      <SectionHeader
        title="Live Devices"
        desc="Every device reporting from Firebase appears below. Set each one to pump-connected or non-pump — the dashboard charts update immediately after you save."
      />

      <Card className="mb-5 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-foreground">
              {liveSensors.length} live device{liveSensors.length === 1 ? '' : 's'} in Firebase
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Pump-connected → 24h or 48h pump drawdown charts. Non-pump → daily median groundwater trend.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refresh()} disabled={liveLoading || busy}>
            Refresh list
          </Button>
        </div>
        {liveError && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            Could not load live devices: {liveError}
          </p>
        )}
      </Card>

      {loading && (
        <div className="py-8 text-center text-sm text-muted-foreground">Loading devices from Firebase and settings…</div>
      )}

      {!loading && deviceRows.length === 0 && (
        <div className="rounded-xl border-2 border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          No devices found in Firebase yet. Devices appear here automatically once they start sending data.
        </div>
      )}

      {!loading && deviceRows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3 font-semibold">Device ID</th>
                  <th className="px-4 py-3 font-semibold">District</th>
                  <th className="px-4 py-3 font-semibold tabular-nums">Depth</th>
                  <th className="px-4 py-3 font-semibold">Live</th>
                  <th className="px-4 py-3 font-semibold">Installation type</th>
                  <th className="px-4 py-3 font-semibold">Dashboard charts</th>
                </tr>
              </thead>
              <tbody>
                {deviceRows.map((row) => (
                  <tr key={row.deviceId} className="border-b border-border/60 hover:bg-muted/10">
                    <td className="px-4 py-3 font-mono font-semibold text-foreground">{row.deviceId}</td>
                    <td className="px-4 py-3 text-muted-foreground">{row.district}</td>
                    <td className="px-4 py-3 tabular-nums">
                      {row.depth != null ? `${row.depth}m` : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[10px] uppercase',
                          row.status === 'active'
                            ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                            : row.isLive
                              ? 'border-amber-300 bg-amber-50 text-amber-700'
                              : 'border-border text-muted-foreground',
                        )}
                      >
                        {row.isLive ? (row.status === 'active' ? 'Active' : 'Offline') : 'Not in Firebase'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={row.installType}
                        onValueChange={(value) =>
                          handleInstallTypeChange(row.deviceId, value as DeviceInstallType)
                        }
                        disabled={busy}
                      >
                        <SelectTrigger className="h-9 w-[11rem]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="z-[70]">
                          <SelectItem value="pump">Pump connected</SelectItem>
                          <SelectItem value="non-pump">Non-pump</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {row.isPumpConnected ? '24h / 48h pump drawdown' : 'Daily median trend'}
                      {!row.hasSavedFlag && (
                        <span className="mt-0.5 block text-[10px] text-amber-600">Default (not saved yet)</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Changes save immediately to device master data. Refresh the dashboard to see updated charts. Run migration{' '}
        <code className="rounded bg-muted px-1">008_add_pump_connected_flag.sql</code> on Supabase if the save fails.
      </p>
    </div>
  );
}

// ─── Media library section ────────────────────────────────────────────────────

function MediaLibrarySection() {
  const [bucket, setBucket] = useState<StorageBucketName>('site-media');
  const [recentUrls, setRecentUrls] = useState<Array<{ url: string; name: string; type: string }>>([]);
  const [uploading, setUploading] = useState(false);

  const onDrop = useCallback(async (files: File[]) => {
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        const res = await uploadFileToBucket(bucket, file, {
          folder:
            bucket === 'deployments-media'
              ? 'deployments'
              : bucket === 'partners-media'
                ? 'partners'
                : 'site',
        });
        setRecentUrls((prev) => [{ url: res.publicUrl, name: file.name, type: file.type }, ...prev]);
        toast({ title: 'Uploaded', description: file.name });
      }
    } catch (err) {
      toast({ title: 'Upload failed', description: errorMessage(err), variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  }, [bucket]);

  const { getRootProps, getInputProps, isDragActive, isDragReject } = useDropzone({
    onDrop,
    disabled: uploading,
    multiple: true,
    accept: { 'image/*': [], 'video/*': [], 'application/pdf': [] },
    maxSize: 200 * 1024 * 1024,
  });

  return (
    <div className="space-y-5">
      <Card className="p-5">
        <div className="mb-4">
          <FieldLabel label="Upload destination" hint="Choose which bucket to upload files into" />
          <Select value={bucket} onValueChange={(v) => setBucket(v as StorageBucketName)} disabled={uploading}>
            <SelectTrigger className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="site-media">site-media — Home page assets</SelectItem>
              <SelectItem value="deployments-media">deployments-media — Deployment assets</SelectItem>
              <SelectItem value="partners-media">partners-media — Partners page assets</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div
          {...getRootProps()}
          className={cn(
            'cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition-colors',
            isDragReject ? 'border-red-400 bg-red-50/30' :
              isDragActive ? 'border-teal-500 bg-teal-50/20' :
                'border-border hover:border-teal-400 hover:bg-teal-50/10',
            uploading && 'pointer-events-none opacity-50',
          )}
        >
          <input {...getInputProps()} />
          <div className="flex flex-col items-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-teal-100">
              <Upload className="h-7 w-7 text-teal-600" />
            </div>
            <div>
              <p className="text-base font-semibold text-foreground">
                {uploading ? 'Uploading files…' : isDragActive ? 'Drop files here' : 'Drag & drop files here'}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Images, videos, PDFs up to 200 MB each · or click to browse
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Uploading to: <span className="font-mono font-medium text-teal-700">{bucket}</span>
              </p>
            </div>
          </div>
        </div>
      </Card>

      {recentUrls.length > 0 && (
        <Card className="p-5">
          <h3 className="mb-3 text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Recently uploaded ({recentUrls.length})
          </h3>
          <div className="space-y-2">
            {recentUrls.map((item, idx) => {
              const isImage = item.type.startsWith('image/');
              return (
                <div key={idx} className="flex items-center gap-3 rounded-xl border border-border bg-muted/20 p-3">
                  {isImage ? (
                    <ZoomableImage src={item.url} alt={item.name} className="h-10 w-10 flex-shrink-0 rounded-lg object-cover" />
                  ) : (
                    <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-blue-100">
                      <Video className="h-5 w-5 text-blue-600" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{item.name}</p>
                    <p className="truncate text-xs text-muted-foreground font-mono">{item.url}</p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(item.url);
                        toast({ title: 'URL copied to clipboard' });
                      } catch {
                        toast({ title: 'Copy failed', variant: 'destructive' });
                      }
                    }}
                    className="flex-shrink-0 text-xs"
                  >
                    Copy URL
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Master & Telemetry Section Component ─────────────────────────────────────

function MasterTablesSection() {
  const [selectedTable, setSelectedTable] = useState<string>('raw_sensor_data');
  const [timeRangeDays, setTimeRangeDays] = useState<number>(30); // Default: Last 30 Days (1 Month)
  const [tableData, setTableData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [showInfoModal, setShowInfoModal] = useState<boolean>(true);

  const TABLES = [
    { id: 'location_master', label: 'A. Location Master', desc: 'locationId, village/City, taluka, district, state, lat, long, status' },
    { id: 'well_master', label: 'A. Well Master', desc: 'wellId, locationId, partnerId, wellName, depth, diameter, area, pump' },
    { id: 'partner_master', label: 'A. Partner Master', desc: 'partnerId, partnerName, partnerType, locationId, email, phone, POC' },
    { id: 'device_master', label: 'A. Device Master', desc: 'deviceId, wellId, serialNo, IMEI, simNumber, startStopMethod, status' },
    { id: 'device_assignment_history', label: 'A. Device Assignment History', desc: 'assignmentId, wellId, deviceId, startDate, endDate, status' },
    { id: 'audit_logs', label: 'A. Centralized Audit Log', desc: 'tableName, recordId, fieldName, oldValue, newValue, editedBy, editedAt' },
    { id: 'raw_sensor_data', label: 'B. Raw Sensor Data', desc: 'deviceId, depth(m), timestamp, uptime, onlineSince, readingDate' },
    { id: 'pump_run_summary', label: 'C. Pump Run Summary', desc: 'pumpRunId, wellId, startTime, stopTime, runtimeMinutes, extractionLiters' },
    { id: 'daily_well_summary', label: 'D. Daily Well Summary', desc: 'wellId, date, medianDepth, extractionLiters, remainingVol, estimatedDays' },
    { id: 'weekly_monthly_well_summary', label: 'E. Weekly/Monthly Well Summary', desc: 'wellId, calcDate, 7DayDepthChange, 7DayExtraction, 30DayDepthChange' },
    { id: 'daily_well_health_summary', label: 'F. Daily Well Health Summary', desc: 'wellId, date, wellHealthStatus, safetyBuffer, dryRunRisk, safePumpOp' },
    { id: 'district_daily_summary', label: 'G. District Daily Summary', desc: 'district, date, activeWells, totalExtraction, avgDepth, avgRuntime' },
    { id: 'weekly_monthly_district_summary', label: 'H. Weekly/Monthly District Summary', desc: 'district, calcDate, 30DayExtraction, avg7DayDepthChange, avg30DayDepthChange' },
    { id: 'alert_definitions', label: 'I. Alerts Definition Table', desc: 'alertCode, alertName, alertLevel, triggerField, triggerLogic, expiryLogic' },
    { id: 'alert_logs', label: 'J. Alert Log Table', desc: 'alertId, alertCode, wellId, district, triggerValue, status, triggeredAt' },
  ];

  const TABLE_INFO: Record<string, {
    title: string;
    source: string;
    calculation: string;
    destination: string;
    columns: { name: string; formula: string }[];
  }> = {
    location_master: {
      title: 'A. Location Master Table',
      source: 'Firebase RTDB Node: /devices/{deviceId}/meta (lat, long, siteName, district, state)',
      calculation: 'Firebase-only. District from meta.district when present, otherwise nearest district to Firebase lat/long. No coordinate fallbacks.',
      destination: 'Saved in Supabase Table: location_master',
      columns: [
        { name: 'location_id', formula: 'LOC-{district}' },
        { name: 'village_city', formula: 'meta.siteName (required from Firebase)' },
        { name: 'taluka', formula: 'meta.taluka || district' },
        { name: 'district', formula: 'meta.district || nearest district from lat/long' },
        { name: 'state', formula: 'meta.state (omitted if missing)' },
        { name: 'latitude', formula: 'meta.lat (required)' },
        { name: 'longitude', formula: 'meta.long / meta.lng (required)' },
        { name: 'status', formula: 'Active' },
      ],
    },
    well_master: {
      title: 'A. Well Master Table',
      source: 'Firebase RTDB Node: /devices/{deviceId}/meta (siteName, wellDepth, wellDiameter, pumpIntakeLevelMeters)',
      calculation: 'Firebase-only. Physical dimensions written only when present in meta — never hardcoded. New wells require meta.wellDepth + meta.wellDiameter.',
      destination: 'Saved in Supabase Table: well_master',
      columns: [
        { name: 'well_id', formula: 'WEL-{deviceId}' },
        { name: 'location_id', formula: 'FK to location_master' },
        { name: 'well_name', formula: 'meta.siteName || Well {deviceId}' },
        { name: 'well_depth_meters', formula: 'meta.wellDepth / meta.wellDepthMeters only (never meta.depth, never default)' },
        { name: 'well_diameter_meters', formula: 'meta.wellDiameter / meta.wellDiameterMeters / meta.diameter only' },
        { name: 'well_area_square_meters', formula: 'π × (diameter / 2)^2 from Firebase diameter' },
        { name: 'pump_attached', formula: 'meta.pumpAttached (omitted if missing)' },
        { name: 'pump_type', formula: 'meta.pumpType (omitted if missing)' },
        { name: 'pump_intake_level_meters', formula: 'meta.pumpIntakeLevelMeters / meta.pumpIntake only' },
      ],
    },
    partner_master: {
      title: 'A. Partner / Owner Master Table',
      source: 'Master registration & partner onboarding configuration.',
      calculation: 'Stores partner organizational relationships and contact points of contact (POC).',
      destination: 'Saved in Supabase Table: partner_master',
      columns: [
        { name: 'partner_id', formula: 'PRT-{code}' },
        { name: 'partner_name', formula: 'Organization or NGO Name' },
        { name: 'partner_type', formula: 'Gram Panchayat / NGO / Individual' },
        { name: 'location_id', formula: 'FK to location_master' },
        { name: 'point_of_contact_name', formula: 'POC Name' },
      ],
    },
    device_master: {
      title: 'A. Device Master Table',
      source: 'Firebase RTDB Node: /devices.json keys & metadata.',
      calculation: 'Registry of JalYantra hardware IoT sensors, SIM credentials, and well assignments.',
      destination: 'Saved in Supabase Table: device_master',
      columns: [
        { name: 'device_id', formula: 'RTDB device key (e.g. 05, 07, 08)' },
        { name: 'well_id', formula: 'FK WEL-{deviceId}' },
        { name: 'device_serial_number', formula: 'Hardware serial / IMEI' },
        { name: 'status', formula: 'Active / Maintenance / Inactive' },
        { name: 'start_stop_method', formula: 'automatic' },
      ],
    },
    device_assignment_history: {
      title: 'A. Device Assignment History Table',
      source: 'Device installation & well migration logs.',
      calculation: 'Tracks start/end dates whenever a sensor device is assigned or moved to a different well.',
      destination: 'Saved in Supabase Table: device_assignment_history',
      columns: [
        { name: 'assignment_id', formula: 'ASG-{uuid}' },
        { name: 'well_id', formula: 'FK well_master' },
        { name: 'device_id', formula: 'FK device_master' },
        { name: 'start_date', formula: 'Assignment Start Date' },
        { name: 'end_date', formula: 'Assignment End Date' },
      ],
    },
    audit_logs: {
      title: 'A. Centralized Audit Log Table',
      source: 'Automated PostgreSQL Audit Trigger: fn_capture_master_audit_log().',
      calculation: 'Captures old_value and new_value diffs on INSERT, UPDATE, or soft-DELETE across master tables.',
      destination: 'Saved in Supabase Table: audit_logs',
      columns: [
        { name: 'table_name', formula: 'Target master table name' },
        { name: 'record_id', formula: 'PK of modified row' },
        { name: 'old_value', formula: 'JSON snapshot before edit' },
        { name: 'new_value', formula: 'JSON snapshot after edit' },
        { name: 'action_type', formula: 'INSERT / UPDATE / DELETE' },
      ],
    },
    raw_sensor_data: {
      title: 'B. Raw Sensor Data Table (Telemetry)',
      source: 'Firebase RTDB Node: /readings/{deviceId}/{readingPushId}',
      calculation: 'Direct immutable append-only telemetry stream recorded by sensors.',
      destination: 'Saved in Supabase Table: raw_sensor_data',
      columns: [
        { name: 'device_id', formula: 'Sensor device ID' },
        { name: 'well_id', formula: 'Associated well ID' },
        { name: 'depth_meters', formula: 'Water level depth from surface (m)' },
        { name: 'timestamp', formula: 'ISO collectedDateTime / timestamp' },
        { name: 'reading_date', formula: 'Date string (YYYY-MM-DD)' },
        { name: 'uptime', formula: 'r.uptimeSeconds' },
        { name: 'online_since', formula: 'r.deviceOnlineSince' },
      ],
    },
    pump_run_summary: {
      title: 'C. Pump Run Summary Table',
      source: 'Derived from consecutive raw depth increases in raw_sensor_data.',
      calculation: 'Pumping Run detected when depth increases (water drops). Extraction = wellArea × dropMeters × 1000 Liters.',
      destination: 'Saved in Supabase Table: pump_run_summary',
      columns: [
        { name: 'pump_run_id', formula: 'PRUN-{uuid}' },
        { name: 'pump_start_time', formula: 'Start timestamp of depth drop' },
        { name: 'pump_stop_time', formula: 'Stop timestamp of depth drop' },
        { name: 'runtime_minutes', formula: '(stopTime - startTime) in minutes' },
        { name: 'extraction_liters', formula: 'wellArea × (stopDepth - startDepth) × 1000 L' },
      ],
    },
    daily_well_summary: {
      title: 'D. Daily Well Summary Table',
      source: 'Calculated daily per well from raw_sensor_data telemetry.',
      calculation: 'Median Depth = Median(depths). Remaining Vol = wellArea × (wellDepth - medianDepth) × 1000 L.',
      destination: 'Saved in Supabase Table: daily_well_summary',
      columns: [
        { name: 'daily_median_water_depth_meters', formula: 'Median(depth readings of the day)' },
        { name: 'daily_pump_run_count', formula: 'Count of depth drop sessions (depth diff ≥ 0.02m)' },
        { name: 'daily_pump_runtime_minutes', formula: 'Sum of active pumping minutes' },
        { name: 'daily_water_extraction_liters', formula: 'wellArea × totalDailyDropMeters × 1000 L' },
        { name: 'remaining_water_depth_meters', formula: 'Max(0, wellDepth - medianDepth)' },
        { name: 'remaining_water_volume_liters', formula: 'wellArea × remaining_water_depth × 1000 L' },
        { name: 'estimated_days_remaining', formula: 'remaining_water_volume_liters ÷ daily_extraction' },
      ],
    },
    weekly_monthly_well_summary: {
      title: 'E. Weekly & Monthly Well Summary Table',
      source: 'Computed over 7-day and 30-day rolling windows from daily_well_summary.',
      calculation: '7-Day Depth Change = medianDepth(today) - medianDepth(7 days ago). 30-Day Change = 7-Day Change × 4.0.',
      destination: 'Saved in Supabase Table: weekly_monthly_well_summary',
      columns: [
        { name: 'seven_day_depth_change_meters', formula: 'medianDepth(today) - medianDepth(7 days ago)' },
        { name: 'thirty_day_depth_change_meters', formula: 'medianDepth(today) - medianDepth(30 days ago)' },
        { name: 'seven_day_water_extraction_liters', formula: 'Sum of 7 days daily extraction' },
      ],
    },
    daily_well_health_summary: {
      title: 'F. Daily Well Health Summary Table',
      source: 'Calculated daily per well based on safety buffer & pump intake level (2.0m).',
      calculation: 'Safety Buffer = remainingDepth - 2.0m. Dry Run Risk = Buffer ≤ 1.0m. Health = Red / Amber / Green.',
      destination: 'Saved in Supabase Table: daily_well_health_summary',
      columns: [
        { name: 'safety_buffer_meters', formula: 'remaining_water_depth - pump_intake_level (2m)' },
        { name: 'dry_run_risk_boolean', formula: 'safety_buffer_meters ≤ 1.0m (Red Status)' },
        { name: 'safe_pump_operation_boolean', formula: 'safety_buffer_meters > 2.0m (Green Status)' },
        { name: 'well_health_status', formula: 'Red IF DryRun; Amber IF Unsafe; Green IF Safe' },
      ],
    },
    district_daily_summary: {
      title: 'G. District Daily Summary Table',
      source: 'Aggregated across all wells within each district for a given date.',
      calculation: 'Active Wells = Count(wells reporting). District Avg Depth = Mean(medianDepths of district wells).',
      destination: 'Saved in Supabase Table: district_daily_summary',
      columns: [
        { name: 'total_active_wells_per_district', formula: 'Count of active reporting sensors in district' },
        { name: 'avg_water_depth_per_district_meters', formula: 'Average median depth across all district wells' },
        { name: 'total_daily_water_extraction_per_district_liters', formula: 'Sum of extraction across district wells' },
      ],
    },
    weekly_monthly_district_summary: {
      title: 'H. Weekly & Monthly District Summary Table',
      source: 'Aggregated over 7-day and 30-day windows across district wells.',
      calculation: 'Avg 7-Day Change = Mean(7-day depth changes across district wells). Avg 30-Day Change = Mean(30-day changes).',
      destination: 'Saved in Supabase Table: weekly_monthly_district_summary',
      columns: [
        { name: 'avg_seven_day_depth_change_per_district_meters', formula: 'Mean(7-day depth changes in district)' },
        { name: 'avg_thirty_day_depth_change_per_district_meters', formula: 'Mean(30-day depth changes in district)' },
        { name: 'thirty_day_water_extraction_per_district_liters', formula: '30-day total extraction across district' },
      ],
    },
    alert_definitions: {
      title: 'I. Alert Definitions Table',
      source: 'Static Master Table seeded with JalYantra threshold rules.',
      calculation: 'Defines trigger logic for DRY_RUN_RISK, LOW_WATER_LEVEL, UNSAFE_PUMP_OPERATION, and POOR_RECOVERY.',
      destination: 'Saved in Supabase Table: alert_definitions',
      columns: [
        { name: 'alert_code', formula: 'Unique code (e.g. DRY_RUN_RISK)' },
        { name: 'trigger_field', formula: 'Target field (e.g. safetyBufferMeters)' },
        { name: 'trigger_logic', formula: 'Expression (safetyBufferMeters ≤ 1.0)' },
        { name: 'expiry_logic', formula: 'Expression (safetyBufferMeters > 1.5)' },
      ],
    },
    alert_logs: {
      title: 'J. Alert Logs Table',
      source: 'Automatically generated when daily telemetry breaches alert_definitions rules.',
      calculation: 'Triggered when safetyBuffer ≤ 1.0m or water depth > 80% of well depth.',
      destination: 'Saved in Supabase Table: alert_logs',
      columns: [
        { name: 'alert_code', formula: 'DRY_RUN_RISK / LOW_WATER_LEVEL' },
        { name: 'trigger_field', formula: 'Field evaluated' },
        { name: 'trigger_value', formula: 'Value at trigger (e.g. 0.85m)' },
        { name: 'status', formula: 'active / expired / acknowledged' },
        { name: 'triggered_at', formula: 'Timestamp of alert trigger' },
      ],
    },
  };

  const loadTableData = useCallback(async (tableName: string) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const { data, error } = await supabase.from(tableName).select('*').limit(50);
      if (error) throw error;
      setTableData(data || []);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to fetch table data');
      setTableData([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTableData(selectedTable);

    // Subscribe to realtime changes on selected table
    const channel = supabase
      .channel(`realtime_${selectedTable}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: selectedTable }, () => {
        loadTableData(selectedTable);
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [selectedTable, loadTableData]);

  const keys = tableData.length > 0 ? Object.keys(tableData[0]) : [];

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Master Tables & Edge Calculations"
        desc="Real-time viewer for Supabase master tables, raw Firebase telemetry, and Edge Function calculations."
      />

      <div className="flex flex-wrap items-center gap-3">
        <Select value={selectedTable} onValueChange={(val) => setSelectedTable(val)}>
          <SelectTrigger className="w-80 h-10 font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[70]">
            {TABLES.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={String(timeRangeDays)} onValueChange={(val) => setTimeRangeDays(Number(val))}>
          <SelectTrigger className="w-56 h-10 font-medium">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="z-[70]">
            <SelectItem value="7">Last 7 Days (1 Week)</SelectItem>
            <SelectItem value="15">Last 15 Days</SelectItem>
            <SelectItem value="30">Last 30 Days (1 Month)</SelectItem>
            <SelectItem value="60">Last 60 Days (2 Months)</SelectItem>
            <SelectItem value="90">Last 90 Days (3 Months)</SelectItem>
            <SelectItem value="365">Last 365 Days (1 Year)</SelectItem>
          </SelectContent>
        </Select>

        <Button
          size="sm"
          variant="outline"
          onClick={() => loadTableData(selectedTable)}
          disabled={loading}
          className="gap-2"
        >
          <Signal className="h-4 w-4 text-teal-600 animate-pulse" />
          Refresh Live Data
        </Button>

        <Button
          size="sm"
          variant="default"
          onClick={async () => {
            setLoading(true);
            try {
              toast({ title: 'Syncing Firebase Data', description: `Fetching last ${timeRangeDays} days RTDB telemetry & computing metrics…` });

              const rtdbUrl = firebaseConfig.databaseURL;
              const apiKey = firebaseConfig.apiKey;

              console.log('[Firebase Sync] Fetching devices and readings from Firebase RTDB:', rtdbUrl);

              // Starts at 00:00 IST so the first day is processed whole — its pump runs are deleted and rebuilt below.
              const cutoffTimeMs = syncWindowStartMs(timeRangeDays);
              const windowStartDate = istDateKey(cutoffTimeMs);

              // Only the selected window's readings are downloaded, not the whole history.
              const [devRes, readings] = await Promise.all([
                fetch(`${rtdbUrl}/devices.json?auth=${apiKey}`).catch((err) => {
                  console.error('[Firebase Sync] Devices fetch error:', err);
                  return null;
                }),
                fetchRtdbReadingsSince(rtdbUrl, cutoffTimeMs, { authToken: apiKey }),
              ]);

              console.log('[Firebase Sync] Devices HTTP status:', devRes?.status, devRes?.ok);
              console.log('[Firebase Sync] Readings fetched for devices:', Object.keys(readings).length);

              const devices = devRes && devRes.ok ? await devRes.json() : {};

              let devCount = 0;
              let rawCount = 0;

              // Seed Static Alert Definitions (Table I)
              await supabase.from('alert_definitions').upsert([
                { alert_code: 'LOW_WATER_LEVEL', alert_name: 'Low Water Level', alert_level: 'well', alert_type: 'warning', trigger_field: 'dailyMedianWaterDepthMeters', trigger_logic: 'dailyMedianWaterDepthMeters > 0.8 * wellDepthMeters', expiry_logic: 'dailyMedianWaterDepthMeters < 0.75 * wellDepthMeters', calculation_frequency: 'End of Day', default_message: 'Water level is approaching critically low levels.' },
                { alert_code: 'DRY_RUN_RISK', alert_name: 'Dry Run Risk', alert_level: 'well', alert_type: 'warning', trigger_field: 'safetyBufferMeters', trigger_logic: 'safetyBufferMeters <= 1.0', expiry_logic: 'safetyBufferMeters > 1.5', calculation_frequency: 'End of Day', default_message: 'High risk of pump dry running. Water buffer above intake is below 1 meter.' },
                { alert_code: 'UNSAFE_PUMP_OPERATION', alert_name: 'Unsafe Pump Operation', alert_level: 'well', alert_type: 'warning', trigger_field: 'safetyBufferMeters', trigger_logic: 'safetyBufferMeters <= 2.0 AND safetyBufferMeters > 1.0', expiry_logic: 'safetyBufferMeters > 2.0', calculation_frequency: 'End of Day', default_message: 'Pump is operating with less than 2 meters safety buffer.' },
                { alert_code: 'POOR_RECOVERY', alert_name: 'Poor Groundwater Recovery', alert_level: 'well', alert_type: 'warning', trigger_field: 'recoveryAmountMeters', trigger_logic: 'recoveryAmountMeters < 0.1 AND hoursGap >= 24', expiry_logic: 'recoveryAmountMeters >= 0.2', calculation_frequency: 'End of Day', default_message: 'Well exhibits minimal groundwater recovery (<0.1m).' },
              ], { onConflict: 'alert_code' });

              // 1. Process Master Tables (A) — Firebase-only values, no hardcoded fallbacks
              const wellDepthMap = new Map<string, number>();
              const wellDiameterMap = new Map<string, number>();
              const wellPumpIntakeMap = new Map<string, number>();
              const wellDistrictMap = new Map<string, string>();
              const wellStateMap = new Map<string, string>();

              const optionalPositive = (value: unknown): number | undefined => {
                if (value === null || value === undefined || value === '') return undefined;
                const n = Number(value);
                return Number.isFinite(n) && n > 0 ? n : undefined;
              };
              const optionalNumber = (value: unknown): number | undefined => {
                if (value === null || value === undefined || value === '') return undefined;
                const n = Number(value);
                return Number.isFinite(n) ? n : undefined;
              };

              // PostgREST caps an unfiltered .select() at 1000 rows (db_max_rows) — pump_run_summary long
              // ago grew past that, so a plain select silently returned an arbitrary ~7% slice of the
              // table and corrupted every daily/weekly aggregate built from it. Page through with
              // .range() until nothing is left.
              const fetchAllRows = async (
                table: string,
                select: string,
                orderColumn: string,
                applyFilter?: (query: any) => any,
              ): Promise<any[]> => {
                const pageSize = 1000;
                const rows: any[] = [];
                let offset = 0;
                while (true) {
                  let query = supabase.from(table).select(select).order(orderColumn, { ascending: true });
                  if (applyFilter) query = applyFilter(query);
                  const { data, error } = await query.range(offset, offset + pageSize - 1);
                  if (error) throw error;
                  if (!data || data.length === 0) break;
                  rows.push(...data);
                  if (data.length < pageSize) break;
                  offset += pageSize;
                }
                return rows;
              };

              // Writes in batches and stops on the first error. One request per row made a 365-day
              // rebuild take thousands of requests, and unchecked errors let a failed save look like success.
              const upsertAll = async (table: string, rows: Record<string, unknown>[], onConflict: string) => {
                for (let i = 0; i < rows.length; i += 500) {
                  const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict });
                  if (error) throw new Error(`Saving ${table} failed: ${errorMessage(error)}`);
                }
              };

              // One alert per episode: raised the first day its trigger condition holds, expired the
              // first later day its exit condition holds (alert_definitions.expiry_logic). alertedDates
              // stops a re-run over the same window from raising a second alert for a day already logged.
              const existingAlerts = await fetchAllRows(
                'alert_logs',
                'alert_id, alert_code, well_id, status, triggered_at',
                'alert_id',
                (q) => q.in('alert_code', ['LOW_WATER_LEVEL', 'DRY_RUN_RISK']),
              );
              const alertedDates = new Set<string>(
                existingAlerts.map((a: any) => `${a.alert_code}_${a.well_id}_${istDateKey(Date.parse(a.triggered_at))}`),
              );
              const openAlerts = new Map<string, { alertId: string; date: string }>();
              for (const a of existingAlerts) {
                if (a.status === 'active') {
                  openAlerts.set(`${a.alert_code}_${a.well_id}`, { alertId: a.alert_id, date: istDateKey(Date.parse(a.triggered_at)) });
                }
              }

              // Seed calculation maps from existing curated rows (read-only). Sync never invents dimensions.
              const { data: existingWells } = await supabase
                .from('well_master')
                .select('well_id, well_depth_meters, well_diameter_meters, pump_intake_level_meters, location_id');
              const existingWellById = new Map<string, any>((existingWells || []).map((w: any) => [w.well_id, w]));
              for (const w of existingWells || []) {
                const depth = optionalPositive(w.well_depth_meters);
                const diameter = optionalPositive(w.well_diameter_meters);
                const intake = optionalPositive(w.pump_intake_level_meters);
                if (depth != null) wellDepthMap.set(w.well_id, depth);
                if (diameter != null) wellDiameterMap.set(w.well_id, diameter);
                if (intake != null) wellPumpIntakeMap.set(w.well_id, intake);
              }

              const { data: existingLocations } = await supabase
                .from('location_master')
                .select('location_id, district, state');
              const locationById = new Map<string, any>((existingLocations || []).map((l: any) => [l.location_id, l]));
              for (const w of existingWells || []) {
                const loc = locationById.get(w.location_id);
                if (loc?.district) wellDistrictMap.set(w.well_id, loc.district);
                if (loc?.state) wellStateMap.set(w.well_id, loc.state);
              }

              if (devices && typeof devices === 'object') {
                for (const [dKey, dNode] of Object.entries(devices)) {
                  const meta = (dNode as any)?.meta || {};
                  const deviceId = String(meta.deviceId || dKey).trim();
                  if (!deviceId) continue;

                  const lat = optionalNumber(meta.lat);
                  const long = optionalNumber(meta.long ?? meta.lng);
                  if (lat == null || long == null) {
                    console.warn(`[Firebase Sync] Skipping device ${deviceId}: meta.lat/long missing`);
                    continue;
                  }

                  const district =
                    String(meta.district || meta.districtName || '').trim() || matchDistrictName(lat, long);
                  const state = String(meta.state || '').trim();
                  const wellId = `WEL-${deviceId}`;
                  // Reuse the well's own curated location_id if it already exists — recomputing a generic
                  // district guess here would create a second, unused location row disconnected from the well.
                  const existingWell = existingWellById.get(wellId);
                  const locationId = existingWell?.location_id || `LOC-${district.toUpperCase().replace(/\s+/g, '-')}`;

                  // Physical dims ONLY from Firebase meta (never meta.depth water-level reading, never defaults)
                  const firebaseWellDepth = optionalPositive(meta.wellDepth ?? meta.wellDepthMeters);
                  const firebaseWellDiameter = optionalPositive(
                    meta.wellDiameter ?? meta.wellDiameterMeters ?? meta.diameter,
                  );
                  const firebasePumpIntake = optionalPositive(meta.pumpIntakeLevelMeters ?? meta.pumpIntake);

                  if (firebaseWellDepth != null) wellDepthMap.set(wellId, firebaseWellDepth);
                  if (firebaseWellDiameter != null) wellDiameterMap.set(wellId, firebaseWellDiameter);
                  if (firebasePumpIntake != null) wellPumpIntakeMap.set(wellId, firebasePumpIntake);
                  wellDistrictMap.set(wellId, district);
                  if (state) wellStateMap.set(wellId, state);

                  // Only create a new location for a device that actually resolves to a real well — either
                  // one that already exists, or one with real Firebase depth/diameter data to create now.
                  // Otherwise Firebase devices with no curated well (test devices, decommissioned units,
                  // not-yet-onboarded units) leave behind orphaned generic-district location rows forever.
                  const wellExists = !!existingWell;
                  const wellWillBeReady = wellExists || (firebaseWellDepth != null && firebaseWellDiameter != null);

                  // location_id, village_city, taluka, district, state are set once at creation and must
                  // never change afterward — the sync only ever INSERTs a new location, never updates these.
                  const locationExists = locationById.has(locationId);
                  if (!locationExists) {
                    if (wellWillBeReady) {
                      const locationPayload: Record<string, unknown> = {
                        location_id: locationId,
                        village_city: String(meta.siteName || '').trim() || district,
                        taluka: String(meta.taluka || '').trim() || district,
                        district,
                        latitude: lat,
                        longitude: long,
                        status: 'Active',
                      };
                      if (state) locationPayload.state = state;
                      await supabase.from('location_master').insert(locationPayload);
                      locationById.set(locationId, { location_id: locationId, district, state });
                    } else {
                      console.warn(
                        `[Firebase Sync] Skipping new location_master for ${locationId}: device ${deviceId} has no known/creatable well`,
                      );
                    }
                  } else {
                    await supabase.from('location_master').update({ latitude: lat, longitude: long, status: 'Active' }).eq('location_id', locationId);
                  }

                  // location_id, well_name, well_depth_meters, well_diameter_meters are locked once a well
                  // exists — only pump metadata/status may be refreshed here; edit the rest via the SQL editor.
                  let wellReady = wellExists;
                  if (wellExists) {
                    const wellUpdatePatch: Record<string, unknown> = { status: 'Active' };
                    if (firebasePumpIntake != null) wellUpdatePatch.pump_intake_level_meters = firebasePumpIntake;
                    if (meta.pumpAttached !== undefined) wellUpdatePatch.pump_attached = Boolean(meta.pumpAttached);
                    if (meta.pumpType) wellUpdatePatch.pump_type = String(meta.pumpType);
                    await supabase.from('well_master').update(wellUpdatePatch).eq('well_id', wellId);
                  } else if (firebaseWellDepth != null && firebaseWellDiameter != null) {
                    const wellInsertPayload: Record<string, unknown> = {
                      well_id: wellId,
                      location_id: locationId,
                      well_name: String(meta.siteName || '').trim() || `Well ${deviceId}`,
                      well_depth_meters: firebaseWellDepth,
                      well_diameter_meters: firebaseWellDiameter,
                      status: 'Active',
                    };
                    if (firebasePumpIntake != null) wellInsertPayload.pump_intake_level_meters = firebasePumpIntake;
                    if (meta.pumpAttached !== undefined) wellInsertPayload.pump_attached = Boolean(meta.pumpAttached);
                    if (meta.pumpType) wellInsertPayload.pump_type = String(meta.pumpType);
                    await supabase.from('well_master').insert(wellInsertPayload);
                    existingWellById.set(wellId, {
                      well_id: wellId,
                      location_id: locationId,
                      well_depth_meters: firebaseWellDepth,
                      well_diameter_meters: firebaseWellDiameter,
                    });
                    wellReady = true;
                  } else {
                    console.warn(
                      `[Firebase Sync] Skipping new well_master for ${wellId}: Firebase meta missing wellDepth/wellDiameter`,
                    );
                  }

                  const devicePayload: Record<string, unknown> = {
                    device_serial_number: deviceId,
                    status: 'Active',
                  };
                  if (wellReady) devicePayload.well_id = wellId;
                  if (meta.startStopMethod) devicePayload.start_stop_method = String(meta.startStopMethod);

                  const { data: existingDevice } = await supabase
                    .from('device_master')
                    .select('device_id')
                    .eq('device_id', deviceId)
                    .maybeSingle();
                  if (existingDevice) {
                    await supabase.from('device_master').update(devicePayload).eq('device_id', deviceId);
                  } else {
                    await supabase.from('device_master').insert({ device_id: deviceId, ...devicePayload });
                  }

                  devCount++;
                }
              }

              // Readings are stored only for devices and wells registered above: raw_sensor_data and the
              // summary tables reference device_master and well_master, so one unregistered device (a test
              // unit, or one with readings but no devices/ entry) made the whole batch fail.
              const registeredDevices = new Set(
                (await fetchAllRows('device_master', 'device_id', 'device_id')).map((row) => row.device_id),
              );
              const registeredWells = new Set(
                (await fetchAllRows('well_master', 'well_id', 'well_id')).map((row) => row.well_id),
              );
              const skippedDevices = new Set<string>();

              // 2. Process Telemetry & Calculate All Summaries (B through J)
              if (readings && typeof readings === 'object') {
                const wellReadingsByDate = new Map<string, Map<string, PumpPoint[]>>();
                const rawRowsToInsert: any[] = [];

                for (const [batchKey, batchNode] of Object.entries(readings)) {
                  if (!batchNode || typeof batchNode !== 'object') continue;
                  if (isPortableDeviceBatch(batchKey, batchNode)) continue; // synced into survey_reading below
                  const deviceId = batchKey;
                  const wellId = `WEL-${deviceId}`;
                  if (!registeredDevices.has(deviceId) || !registeredWells.has(wellId)) {
                    skippedDevices.add(deviceId);
                    continue;
                  }

                  const wellDepthForReadings = wellDepthMap.get(wellId);
                  const entries = Object.entries(batchNode as Record<string, any>);
                  for (const [rKey, r] of entries) {
                    if (!r || typeof r !== 'object') continue;
                    const depth = Number(r.depth);
                    if (!isUsableDepth(depth, { wellDepthM: wellDepthForReadings, qualityOk: readingQualityOk(r) })) continue;

                    // Device times are IST without a zone — parsed the same way whatever timezone this
                    // browser is in. Clock-unset readings are dropped, never stamped "now".
                    const readingTimeMs = readingTimestampMs(rKey, r);
                    if (readingTimeMs == null || readingTimeMs < cutoffTimeMs) continue;

                    const isoDate = new Date(readingTimeMs).toISOString();
                    const readingDate = istDateKey(readingTimeMs);
                    const onlineSinceMs = readingTimestampMs('', { collectedDateTime: r.deviceOnlineSince });

                    rawRowsToInsert.push({
                      device_id: deviceId,
                      well_id: wellId,
                      depth_meters: depth,
                      timestamp: isoDate,
                      uptime: r.uptimeSeconds || null,
                      online_since: onlineSinceMs != null ? new Date(onlineSinceMs).toISOString() : null,
                    });

                    rawCount++;

                    // Group depths per well & per date for median & metric calculations
                    if (!wellReadingsByDate.has(wellId)) wellReadingsByDate.set(wellId, new Map());
                    const dateMap = wellReadingsByDate.get(wellId)!;
                    if (!dateMap.has(readingDate)) dateMap.set(readingDate, []);
                    dateMap.get(readingDate)!.push({
                      depth,
                      timestampMs: readingTimeMs,
                      onlineSince: typeof r.deviceOnlineSince === 'string' ? r.deviceOnlineSince : null,
                    });
                  }
                }

                // Perform bulk upsert of raw telemetry (deduplicating by device_id + timestamp in memory first)
                const uniqueRowsMap = new Map<string, any>();
                for (const row of rawRowsToInsert) {
                  const key = `${row.device_id}_${row.timestamp}`;
                  if (!uniqueRowsMap.has(key)) {
                    uniqueRowsMap.set(key, row);
                  }
                }
                // The (device_id, timestamp) unique constraint does the duplicate check — a pre-select
                // was capped at 1,000 rows by PostgREST and so missed most existing rows.
                const rowsToUpsert = Array.from(uniqueRowsMap.values());
                for (let i = 0; i < rowsToUpsert.length; i += 1000) {
                  const chunk = rowsToUpsert.slice(i, i + 1000);
                  const { error } = await supabase
                    .from('raw_sensor_data')
                    .upsert(chunk, { onConflict: 'device_id,timestamp', ignoreDuplicates: true });
                  if (error) throw error;
                }

                // 2.5. Detect Pump Runs from Raw Depth Readings & Insert into pump_run_summary (C)
                // Runs are detected over the well's whole window (so pumping across midnight stays one
                // run) with the same rules as the dashboard, then filed under the IST date they started.
                // Each date in the window is replaced (delete + insert) — the window starts at 00:00 IST,
                // so every date here is rebuilt from a full day of readings.
                for (const [wellId, dateMap] of wellReadingsByDate.entries()) {
                  const wellAreaForRuns = wellAreaM2(wellDiameterMap.get(wellId));
                  const sorted = Array.from(dateMap.values()).flat().sort((a, b) => a.timestampMs - b.timestampMs);

                  const runsByDate = new Map<string, { start: PumpPoint; end: PumpPoint }[]>();
                  for (const range of detectPumpRunRanges(sorted)) {
                    const start = sorted[range.startIdx];
                    const end = sorted[range.endIdx];
                    if (!isCountablePumpRun(start, end)) continue;
                    const runDate = istDateKey(start.timestampMs);
                    const list = runsByDate.get(runDate) || [];
                    list.push({ start, end });
                    runsByDate.set(runDate, list);
                  }

                  const wellRunRows: Record<string, unknown>[] = [];
                  for (const dateStr of dateMap.keys()) {
                    const runs = runsByDate.get(dateStr) || [];
                    const rowsForDate = runs.map(({ start, end }, idx) => {
                      const drop = Math.max(0, end.depth - start.depth);
                      return {
                        well_id: wellId,
                        run_date: dateStr,
                        pump_start_time: new Date(start.timestampMs).toISOString(),
                        pump_stop_time: new Date(end.timestampMs).toISOString(),
                        pump_runtime_minutes: Math.max(0, (end.timestampMs - start.timestampMs) / 60000),
                        pump_start_depth_meters: start.depth,
                        pump_stop_depth_meters: end.depth,
                        water_level_drop_during_run_meters: drop,
                        pump_extraction_per_run_liters: wellAreaForRuns != null ? wellAreaForRuns * drop * 1000.0 : 0,
                        is_first_run_of_day: idx === 0,
                        is_last_run_of_day: idx === runs.length - 1,
                        updated_at: new Date().toISOString(),
                      };
                    });

                    wellRunRows.push(...rowsForDate);
                  }

                  const wellDates = Array.from(dateMap.keys());
                  for (let i = 0; i < wellDates.length; i += 100) {
                    const { error } = await supabase
                      .from('pump_run_summary')
                      .delete()
                      .eq('well_id', wellId)
                      .in('run_date', wellDates.slice(i, i + 100));
                    if (error) throw new Error(`Clearing pump_run_summary failed: ${errorMessage(error)}`);
                  }
                  await upsertAll('pump_run_summary', wellRunRows, 'well_id,pump_start_time,pump_stop_time');
                }

                // Pull real pump run data — this is the single source of truth for run counts/runtime/extraction.
                // Scoped to the same readings window this run is processing, and paginated (see
                // fetchAllRows) since pump_run_summary has long since grown past PostgREST's 1000-row
                // default select cap.
                const pumpRunCutoffDateStr = windowStartDate;
                const pumpRunRows = await fetchAllRows(
                  'pump_run_summary',
                  'well_id, run_date, pump_runtime_minutes, pump_extraction_per_run_liters, water_level_drop_during_run_meters',
                  'pump_run_id',
                  (q) => q.gte('run_date', pumpRunCutoffDateStr),
                );
                const pumpRunsByWellDate = new Map<string, { count: number; runtime: number; extraction: number; drop: number }>();
                for (const row of pumpRunRows || []) {
                  const key = `${row.well_id}_${row.run_date}`;
                  const agg = pumpRunsByWellDate.get(key) || { count: 0, runtime: 0, extraction: 0, drop: 0 };
                  agg.count += 1;
                  agg.runtime += Number(row.pump_runtime_minutes) || 0;
                  agg.extraction += Number(row.pump_extraction_per_run_liters) || 0;
                  agg.drop += Number(row.water_level_drop_during_run_meters) || 0;
                  pumpRunsByWellDate.set(key, agg);
                }

                // 3. Compute Derived Per-Well Summaries (D, E, F, J)
                const districtDailyAgg = new Map<string, { wells: Set<string>; depthSum: number; depthCount: number; extraction: number; runtime: number }>();
                // 7/30-day depth-change contributions per district+date, averaged across that district's wells —
                // feeds weekly_monthly_district_summary alongside the rolling 30-day extraction computed below.
                const districtWeeklyAgg = new Map<string, { sevenDaySum: number; sevenDayCount: number; thirtyDaySum: number; thirtyDayCount: number }>();

                // Daily medians from just before the window, so 7- and 30-day changes have something
                // to compare against on the window's first days.
                const priorMedianRows = await fetchAllRows(
                  'daily_well_summary',
                  'well_id, date, daily_median_water_depth_meters, daily_water_extraction_liters',
                  'date',
                  (q) => q.gte('date', addDaysToDateKey(windowStartDate, -31)).lt('date', windowStartDate),
                );
                const priorMediansByWell = new Map<string, Map<string, number>>();
                const priorExtractionByWell = new Map<string, Map<string, number>>();
                for (const row of priorMedianRows) {
                  const median = Number(row.daily_median_water_depth_meters);
                  if (Number.isFinite(median)) {
                    if (!priorMediansByWell.has(row.well_id)) priorMediansByWell.set(row.well_id, new Map());
                    priorMediansByWell.get(row.well_id)!.set(row.date, median);
                  }
                  if (!priorExtractionByWell.has(row.well_id)) priorExtractionByWell.set(row.well_id, new Map());
                  priorExtractionByWell.get(row.well_id)!.set(row.date, Number(row.daily_water_extraction_liters) || 0);
                }

                const weeklyWellRows: Record<string, unknown>[] = [];
                const dailyWellRows: Record<string, unknown>[] = [];
                const dailyHealthRows: Record<string, unknown>[] = [];
                for (const [wellId, dateMap] of wellReadingsByDate.entries()) {
                  const sortedDates = Array.from(dateMap.keys()).sort();
                  const wellDepth = wellDepthMap.get(wellId);
                  const pumpIntake = wellPumpIntakeMap.get(wellId);
                  const wellArea = wellAreaM2(wellDiameterMap.get(wellId));
                  const district = wellDistrictMap.get(wellId);
                  const state = wellStateMap.get(wellId);

                  const dailyExtractionByDate = new Map<string, number>(priorExtractionByWell.get(wellId) || []);
                  const dailyMedianByDate = new Map<string, number>(priorMediansByWell.get(wellId) || []);
                  for (const dateStr of sortedDates) {
                    const dayReadings = dateMap.get(dateStr)!;
                    const medianDepth = medianOf(dayReadings.map(r => r.depth));
                    dailyMedianByDate.set(dateStr, medianDepth);
                    const lastReadingMs = Math.max(...dayReadings.map(r => r.timestampMs));

                    const safety = wellSafety({ medianDepthM: medianDepth, wellDepthM: wellDepth, pumpIntakeM: pumpIntake });
                    const remainingDepth = safety.remainingDepthM;
                    const remainingVolumeLiters =
                      remainingDepth != null && wellArea != null ? wellArea * remainingDepth * 1000.0 : null;
                    const safetyBuffer = safety.safetyBufferM;
                    const dryRunRisk = safety.dryRunRisk;
                    const safePumpOp = safety.safePumpOperation;

                    // Use actual pump run data — no re-derivation, no fabrication
                    const runAgg = pumpRunsByWellDate.get(`${wellId}_${dateStr}`) || { count: 0, runtime: 0, extraction: 0, drop: 0 };
                    const dailyPumpRunCount = runAgg.count;
                    const dailyPumpRuntimeMinutes = runAgg.runtime;
                    const dailyWaterExtractionLiters = runAgg.extraction;
                    const totalDropMeters = runAgg.drop;
                    dailyExtractionByDate.set(dateStr, dailyWaterExtractionLiters);
                    // 7 calendar days ending today, not the last 7 days that happened to have data.
                    const sevenDay = rollingCalendarWindow(dailyExtractionByDate, dateStr, 7);
                    const sevenDayWaterExtractionLiters = sevenDay.sum;
                    const avgSevenDayExtractionLiters = sevenDay.avg;

                    // Weekly/Monthly Well Summary (E) — populated every day so daily_well_summary below reads
                    // avg_seven_day_extraction_liters back from this same table, not a private local copy.
                    const change7Days = depthChangeOverDays(dailyMedianByDate, dateStr, 7);
                    const change30Days = depthChangeOverDays(dailyMedianByDate, dateStr, 30);
                    const weeklyPayload: Record<string, unknown> = {
                      well_id: wellId,
                      calculation_date: dateStr,
                      seven_day_water_extraction_liters: sevenDayWaterExtractionLiters,
                      avg_seven_day_extraction_liters: avgSevenDayExtractionLiters,
                      seven_day_depth_change_meters: change7Days,
                      thirty_day_depth_change_meters: change30Days,
                      updated_at: new Date().toISOString(),
                    };
                    if (district && (change7Days != null || change30Days != null)) {
                      const wAggKey = `${district}__${dateStr}`;
                      const wAgg = districtWeeklyAgg.get(wAggKey) || { sevenDaySum: 0, sevenDayCount: 0, thirtyDaySum: 0, thirtyDayCount: 0 };
                      if (change7Days != null) {
                        wAgg.sevenDaySum += change7Days;
                        wAgg.sevenDayCount += 1;
                      }
                      if (change30Days != null) {
                        wAgg.thirtyDaySum += change30Days;
                        wAgg.thirtyDayCount += 1;
                      }
                      districtWeeklyAgg.set(wAggKey, wAgg);
                    }
                    weeklyWellRows.push(weeklyPayload);

                    // Daily Well Summary (D)
                    dailyWellRows.push({
                      well_id: wellId,
                      date: dateStr,
                      daily_median_water_depth_meters: medianDepth,
                      daily_pump_run_count: dailyPumpRunCount,
                      daily_pump_runtime_minutes: dailyPumpRuntimeMinutes,
                      daily_water_extraction_liters: dailyWaterExtractionLiters,
                      daily_water_level_drop_meters: totalDropMeters,
                      remaining_water_depth_meters: remainingDepth,
                      remaining_water_volume_liters: remainingVolumeLiters,
                      estimated_days_remaining:
                        remainingVolumeLiters != null && avgSevenDayExtractionLiters > 0
                          ? remainingVolumeLiters / avgSevenDayExtractionLiters
                          : null,
                      updated_at: new Date().toISOString(),
                    });

                    // Daily Well Health Summary (F)
                    let healthStatus = 'Green';
                    if (dryRunRisk) healthStatus = 'Red';
                    else if (!safePumpOp) healthStatus = 'Amber';

                    dailyHealthRows.push({
                      well_id: wellId,
                      date: dateStr,
                      well_health_status: healthStatus,
                      safety_buffer_meters: safetyBuffer,
                      dry_run_risk_boolean: dryRunRisk,
                      safe_pump_operation_boolean: safePumpOp,
                      device_health_status: deviceHealthForDay(lastReadingMs, dateStr),
                      updated_at: new Date().toISOString(),
                    });

                    // Alert Log Generation (J)
                    const alertChecks = [
                      {
                        code: 'DRY_RUN_RISK',
                        triggered: dryRunRisk && safetyBuffer != null,
                        cleared: safety.dryRunCleared,
                        field: 'safetyBufferMeters',
                        value: safetyBuffer != null ? `${safetyBuffer.toFixed(2)}m` : '',
                      },
                      {
                        code: 'LOW_WATER_LEVEL',
                        triggered: safety.lowWaterLevel,
                        cleared: safety.lowWaterCleared,
                        field: 'dailyMedianWaterDepthMeters',
                        value: `${medianDepth.toFixed(2)}m`,
                      },
                    ];
                    for (const check of alertChecks) {
                      const openKey = `${check.code}_${wellId}`;
                      const open = openAlerts.get(openKey);
                      if (check.triggered && !open) {
                        const datedKey = `${check.code}_${wellId}_${dateStr}`;
                        if (alertedDates.has(datedKey)) continue;
                        const { data: inserted, error: alertError } = await supabase.from('alert_logs').insert({
                          alert_code: check.code,
                          well_id: wellId,
                          district: district || null,
                          state: state || null,
                          alert_type: 'warning',
                          trigger_field: check.field,
                          trigger_value: check.value,
                          status: 'active',
                          triggered_at: istNoonIso(dateStr),
                        }).select('alert_id').maybeSingle();
                        if (alertError) throw new Error(`Saving alert_logs failed: ${errorMessage(alertError)}`);
                        alertedDates.add(datedKey);
                        if (inserted?.alert_id) openAlerts.set(openKey, { alertId: inserted.alert_id, date: dateStr });
                      } else if (check.cleared && open && open.date < dateStr) {
                        const { error: expireError } = await supabase
                          .from('alert_logs')
                          .update({ status: 'expired', expired_at: istNoonIso(dateStr) })
                          .eq('alert_id', open.alertId);
                        if (expireError) throw new Error(`Expiring alert failed: ${errorMessage(expireError)}`);
                        openAlerts.delete(openKey);
                      }
                    }

                    if (district) {
                      const aggKey = `${district}__${dateStr}`;
                      const agg = districtDailyAgg.get(aggKey) || {
                        wells: new Set<string>(),
                        depthSum: 0,
                        depthCount: 0,
                        extraction: 0,
                        runtime: 0,
                      };
                      agg.wells.add(wellId);
                      agg.depthSum += medianDepth;
                      agg.depthCount += 1;
                      agg.extraction += dailyWaterExtractionLiters;
                      agg.runtime += dailyPumpRuntimeMinutes;
                      districtDailyAgg.set(aggKey, agg);
                    }
                  }
                }

                await upsertAll('weekly_monthly_well_summary', weeklyWellRows, 'well_id, calculation_date');
                await upsertAll('daily_well_summary', dailyWellRows, 'well_id, date');
                await upsertAll('daily_well_health_summary', dailyHealthRows, 'well_id, date');

                // 4. Compute Per-District Summaries (G, H) from real aggregated Firebase-derived data
                const districtDailyRows: Record<string, unknown>[] = [];
                for (const [aggKey, agg] of districtDailyAgg.entries()) {
                  const [districtName, dateStr] = aggKey.split('__');
                  districtDailyRows.push({
                    district: districtName,
                    date: dateStr,
                    total_active_wells_per_district: agg.wells.size,
                    total_daily_water_extraction_per_district_liters: agg.extraction,
                    total_daily_pump_runtime_per_district_minutes: agg.runtime,
                    avg_water_depth_per_district_meters: agg.depthCount > 0 ? agg.depthSum / agg.depthCount : null,
                    avg_daily_pump_runtime_per_district_minutes: agg.wells.size > 0 ? agg.runtime / agg.wells.size : null,
                    updated_at: new Date().toISOString(),
                  });
                }
                await upsertAll('district_daily_summary', districtDailyRows, 'district, date');

                // 5. Weekly/Monthly District Summary (H) — 7/30-day depth change averaged across the
                // district's wells (from districtWeeklyAgg above); 30-day extraction as a rolling sum
                // of this district's own daily totals, same rolling-window pattern as the well-level
                // 7-day extraction above.
                const districtDailySeries = new Map<string, { date: string; extraction: number }[]>();
                for (const [aggKey, agg] of districtDailyAgg.entries()) {
                  const [districtName, dateStr] = aggKey.split('__');
                  const series = districtDailySeries.get(districtName) || [];
                  series.push({ date: dateStr, extraction: agg.extraction });
                  districtDailySeries.set(districtName, series);
                }
                const districtWeeklyRows: Record<string, unknown>[] = [];
                for (const [districtName, series] of districtDailySeries.entries()) {
                  series.sort((a, b) => a.date.localeCompare(b.date));
                  for (let i = 0; i < series.length; i++) {
                    const dateStr = series[i].date;
                    const last30 = series.slice(Math.max(0, i - 29), i + 1);
                    const thirtyDayExtraction = last30.reduce((sum, d) => sum + d.extraction, 0);
                    const wAgg = districtWeeklyAgg.get(`${districtName}__${dateStr}`);
                    // Every row carries the same columns, as a batched upsert requires; no data → null.
                    districtWeeklyRows.push({
                      district: districtName,
                      calculation_date: dateStr,
                      thirty_day_water_extraction_per_district_liters: thirtyDayExtraction,
                      avg_seven_day_depth_change_per_district_meters:
                        wAgg && wAgg.sevenDayCount > 0 ? wAgg.sevenDaySum / wAgg.sevenDayCount : null,
                      avg_thirty_day_depth_change_per_district_meters:
                        wAgg && wAgg.thirtyDayCount > 0 ? wAgg.thirtyDaySum / wAgg.thirtyDayCount : null,
                      updated_at: new Date().toISOString(),
                    });
                  }
                }
                await upsertAll('weekly_monthly_district_summary', districtWeeklyRows, 'district, calculation_date');
              }

              // Portable (Porta-*) readings were skipped above — they go to survey_reading instead.
              const surveySync = await syncPortableReadings().catch((err) => {
                console.warn('[Firebase Sync] Portable survey sync failed:', err);
                return null;
              });

              toast({
                title: '30-Day Firebase Data Sync Complete',
                description: `Successfully processed ${devCount} devices and ${rawCount} raw readings into Supabase master and summary tables.${
                  surveySync ? ` Survey readings: ${surveySync.saved} saved, ${surveySync.unmatched.length} unmatched.` : ''
                }${
                  skippedDevices.size
                    ? ` Skipped devices not registered in device_master/well_master: ${Array.from(skippedDevices).join(', ')}.`
                    : ''
                }`,
              });

            } catch (e: any) {
              toast({ title: 'Sync Error', description: e.message || 'Failed to sync Firebase data.', variant: 'destructive' });
            } finally {
              setLoading(false);
            }
          }}
          disabled={loading}
          className="gap-2 bg-teal-700 hover:bg-teal-800"
        >
          <Upload className="h-4 w-4" />
          Fetch & Populate Firebase RTDB Data
        </Button>
      </div>

      {errorMsg && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          Note: {errorMsg} (Make sure migration <code className="font-mono font-bold">010_master_raw_summary_alerts_schema.sql</code> is run on your Supabase instance).
        </p>
      )}

      {TABLE_INFO[selectedTable] && (
        <Card className="border-teal-200 bg-teal-50/50 p-4 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Info className="h-5 w-5 text-teal-700" />
              <h4 className="font-bold text-sm text-teal-950">{TABLE_INFO[selectedTable].title} - Formula & Data Pipeline Info</h4>
            </div>
            <Button size="sm" variant="ghost" className="h-7 text-xs text-teal-800" onClick={() => setShowInfoModal(!showInfoModal)}>
              {showInfoModal ? 'Hide Details' : 'Show Details & Formulas'}
            </Button>
          </div>

          {showInfoModal && (
            <div className="space-y-2 text-xs text-teal-900 border-t border-teal-200/60 pt-3">
              <p><strong>📥 Data Source:</strong> {TABLE_INFO[selectedTable].source}</p>
              <p><strong>🧮 Calculation Logic & Formulas:</strong> {TABLE_INFO[selectedTable].calculation}</p>
              <p><strong>💾 Storage Location:</strong> {TABLE_INFO[selectedTable].destination}</p>
              <div>
                <strong className="block mb-1">📊 Columns & Mathematical Formulas:</strong>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-1">
                  {TABLE_INFO[selectedTable].columns.map((col) => (
                    <div key={col.name} className="bg-white/80 rounded border border-teal-200 p-2 font-mono text-[11px]">
                      <span className="font-bold text-teal-950">{col.name}:</span> <span className="text-teal-700">{col.formula}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card className="overflow-hidden">
        <div className="p-4 border-b border-border bg-muted/20 flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-sm text-foreground flex items-center gap-2">
              {TABLES.find((t) => t.id === selectedTable)?.label}
              <Button size="icon" variant="ghost" className="h-6 w-6 text-teal-600" title="View Table Info & Formulas" onClick={() => setShowInfoModal(!showInfoModal)}>
                <Info className="h-4 w-4" />
              </Button>
            </h3>
            <p className="text-xs text-muted-foreground">
              {TABLES.find((t) => t.id === selectedTable)?.desc} · {tableData.length} records shown (Realtime subscription active)
            </p>
          </div>
          <Badge variant="outline" className="border-emerald-300 bg-emerald-50 text-emerald-700 text-[10px] uppercase">
            Live Sync
          </Badge>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Fetching records from Supabase…</div>
        ) : tableData.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted-foreground">
            No rows found in table <code className="font-mono text-teal-700">{selectedTable}</code> yet. Data will appear automatically when Edge Function processes Firebase RTDB updates.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-[11px] uppercase tracking-wider text-muted-foreground">
                  {keys.map((k) => (
                    <th key={k} className="px-3 py-2.5 font-semibold">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {tableData.map((row, idx) => (
                  <tr key={idx} className="hover:bg-muted/20 transition-colors">
                    {keys.map((k) => (
                      <td key={k} className="px-3 py-2.5 font-mono text-[11px] text-foreground max-w-[200px] truncate">
                        {typeof row[k] === 'object' && row[k] !== null
                          ? JSON.stringify(row[k])
                          : String(row[k] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

