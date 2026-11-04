import { CalendarRange, MapPinned, Droplets, Waves } from 'lucide-react';
import { KPICard } from '@/components/KPICards';
import { LatestSurveySnapshot } from '@/lib/surveyData';

interface SurveySnapshotCardsProps {
  snapshot: LatestSurveySnapshot | null;
  isLoading: boolean;
}

function formatDay(value: string): string {
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatRange(start: string | null, end: string | null): string {
  if (!start && !end) return '—';
  if (!start || !end || start === end) return formatDay((start ?? end)!);
  return `${formatDay(start)} – ${formatDay(end)}`;
}

/** "Latest Survey Snapshot" — the most recently Completed survey (see fetchLatestSurveySnapshot). */
export function SurveySnapshotCards({ snapshot, isLoading }: SurveySnapshotCardsProps) {
  // Hidden while loading and when no survey has been completed yet, rather than showing zeros.
  if (isLoading || !snapshot) return null;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-foreground uppercase tracking-wide">Latest Survey Snapshot</h2>
        <span className="text-xs text-muted-foreground">
          Survey: <span className="font-medium text-foreground">{snapshot.surveyName}</span>
        </span>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Survey Date"
          value={formatRange(snapshot.startDate, snapshot.endDate)}
          subtitle={snapshot.startDate && snapshot.endDate && snapshot.startDate !== snapshot.endDate ? 'Survey period' : 'Survey day'}
          icon={CalendarRange}
          accentColor="#6366f1"
          accentBg="rgba(99,102,241,0.10)"
          delay={0}
        />
        <KPICard
          title="Villages Covered"
          value={snapshot.villagesCovered}
          subtitle="Villages in this survey"
          icon={MapPinned}
          accentColor="#0ea5a4"
          accentBg="rgba(14,165,164,0.10)"
          delay={0.08}
        />
        <KPICard
          title="Wells Surveyed"
          value={snapshot.wellsSurveyed}
          subtitle="Wells with a reading"
          icon={Droplets}
          accentColor="#06b6d4"
          accentBg="rgba(6,182,212,0.10)"
          delay={0.16}
        />
        <KPICard
          title="Average Depth"
          value={snapshot.averageDepthMeters != null ? `${snapshot.averageDepthMeters.toFixed(1)}m` : '—'}
          subtitle="Mean depth to water"
          icon={Waves}
          accentColor={snapshot.averageDepthMeters != null && snapshot.averageDepthMeters > 20 ? '#ef4444' : '#0ea5e9'}
          accentBg={snapshot.averageDepthMeters != null && snapshot.averageDepthMeters > 20 ? 'rgba(239,68,68,0.10)' : 'rgba(14,165,233,0.10)'}
          delay={0.24}
        />
      </div>
    </section>
  );
}
