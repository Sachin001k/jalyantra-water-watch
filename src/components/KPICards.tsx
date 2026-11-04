import { motion } from 'framer-motion';
import { Activity, Waves, AlertTriangle, TrendingDown, LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { KPIStats } from '@/lib/data';

interface KPICardsProps {
  stats: KPIStats | null;
  isLoading: boolean;
}

interface KPICardProps {
  title: string;
  value: string | number;
  subtitle: string;
  icon: LucideIcon;
  trend?: 'up' | 'down' | 'neutral';
  trendValue?: string;
  accentColor?: string;
  accentBg?: string;
  delay?: number;
}

export function KPICard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  trendValue,
  accentColor = '#0ea5a4',
  accentBg = 'rgba(14,165,164,0.10)',
  delay = 0,
}: KPICardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay, ease: 'easeOut' }}
      className="kpi-card"
      style={{ background: '#ffffff', borderRadius: '16px', border: '1px solid #e2e8f0' }}
    >
      {/* Icon + Trend */}
      <div className="flex items-start justify-between mb-5">
        {/* Circular icon */}
        <div
          className="icon-circle"
          style={{ background: accentBg, width: 48, height: 48 }}
        >
          <Icon style={{ width: 22, height: 22, color: accentColor }} />
        </div>

        {/* Trend badge */}
        {trend && trendValue && (
          <div
            className="flex items-center gap-1 text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide"
            style={{
              background: trend === 'down'
                ? 'rgba(239,68,68,0.1)'
                : trend === 'up'
                  ? 'rgba(34,197,94,0.1)'
                  : 'rgba(100,116,139,0.1)',
              color: trend === 'down' ? '#ef4444' : trend === 'up' ? '#22c55e' : '#64748b',
            }}
          >
            <TrendingDown
              style={{ width: 10, height: 10, transform: trend === 'up' ? 'rotate(180deg)' : 'none' }}
            />
            {trendValue}
          </div>
        )}
      </div>

      {/* Value block */}
      <div className="space-y-1">
        <p
          style={{
            fontSize: '11px',
            fontFamily: 'Inter, sans-serif',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            color: '#94a3b8',
          }}
        >
          {title}
        </p>
        <p
          style={{
            fontSize: '28px',
            fontFamily: 'Poppins, Inter, sans-serif',
            fontWeight: 700,
            color: '#0f172a',
            lineHeight: 1.1,
            letterSpacing: '-0.02em',
          }}
        >
          {value}
        </p>
        <p style={{ fontSize: '13px', color: '#64748b', fontFamily: 'Inter, sans-serif' }}>
          {subtitle}
        </p>
      </div>

      {/* Bottom accent bar */}
      <div
        className="mt-4 h-0.5 rounded-full"
        style={{ background: `linear-gradient(90deg, ${accentColor}60, transparent)` }}
      />
    </motion.div>
  );
}

export function KPICards({ stats, isLoading }: KPICardsProps) {
  if (isLoading || !stats) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div
            key={i}
            className="kpi-card animate-pulse"
            style={{ background: '#ffffff', borderRadius: '16px', border: '1px solid #e2e8f0' }}
          >
            <div className="w-12 h-12 rounded-full bg-[#f1f5f9] mb-5" />
            <div className="space-y-2">
              <div className="h-3 w-24 bg-[#f1f5f9] rounded-full" />
              <div className="h-8 w-20 bg-[#f1f5f9] rounded-full" />
              <div className="h-3 w-32 bg-[#f1f5f9] rounded-full" />
            </div>
          </div>
        ))}
      </div>
    );
  }


  // Rounded to the 0.1 m shown, so a change that displays as 0.0 m reads "Stable", not "-0m".
  const declineM = Math.round(stats.fastestDeclineRate * 10) / 10;
  const hasDecline = declineM > 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <KPICard
        title="Total Sensors"
        value={stats.totalSensors}
        subtitle="Monitored locations"
        icon={Activity}
        accentColor="#0ea5a4"
        accentBg="rgba(14,165,164,0.10)"
        delay={0}
      />
      <KPICard
        title="Average Depth"
        value={`${stats.avgDepth}m`}
        subtitle="State-wide average"
        icon={Waves}
        trend={stats.avgDepth > 15 ? 'down' : 'neutral'}
        trendValue={stats.avgDepth > 15 ? 'High' : 'Normal'}
        accentColor={stats.avgDepth > 15 ? '#f97316' : '#06b6d4'}
        accentBg={stats.avgDepth > 15 ? 'rgba(249,115,22,0.10)' : 'rgba(6,182,212,0.10)'}
        delay={0.08}
      />
      <KPICard
        title="Critical Districts"
        value={`${stats.criticalPercentage}%`}
        subtitle="Above 20m depth threshold"
        icon={AlertTriangle}
        accentColor={stats.criticalPercentage > 20 ? '#ef4444' : '#22c55e'}
        accentBg={stats.criticalPercentage > 20 ? 'rgba(239,68,68,0.10)' : 'rgba(34,197,94,0.10)'}
        delay={0.16}
      />
      <KPICard
        title="Fastest Decline"
        value={hasDecline ? stats.fastestDecliningDistrict : 'Stable'}
        subtitle={hasDecline ? `-${declineM.toFixed(1)}m in 30 days` : 'No change in 30 days'}
        icon={TrendingDown}
        trend={hasDecline ? 'down' : 'neutral'}
        trendValue={hasDecline ? `-${declineM.toFixed(1)}m` : '0.0m'}
        accentColor={hasDecline ? '#ef4444' : '#64748b'}
        accentBg={hasDecline ? 'rgba(239,68,68,0.10)' : 'rgba(100,116,139,0.10)'}
        delay={0.24}
      />
    </div>
  );
}
