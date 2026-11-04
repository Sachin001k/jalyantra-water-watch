import { useCallback, useEffect, useState } from 'react';
import { get, ref } from 'firebase/database';
import {
  FirebaseDevicesTree,
  SensorReading,
  mergeReadingsWithDeviceRegistry,
  transformFirebaseReadings,
} from '@/lib/data';
import { database } from '@/lib/firebaseClient';
import { DEVICES_PATH, fetchDashboardReadings } from '@/lib/firebaseReadings';

/** Live sensors from Firebase RTDB — for Admin device settings. */
export function useLiveDevices() {
  const [sensors, setSensors] = useState<SensorReading[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [readings, devicesSnapshot] = await Promise.all([
        fetchDashboardReadings(),
        get(ref(database, DEVICES_PATH)),
      ]);
      const merged = mergeReadingsWithDeviceRegistry(
        transformFirebaseReadings(readings),
        (devicesSnapshot.val() ?? {}) as FirebaseDevicesTree,
      );
      setSensors(merged);
    } catch (err) {
      console.error('Failed to fetch live devices', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { sensors, isLoading, error, refresh };
}
