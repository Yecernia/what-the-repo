import { useEffect, useState } from 'react';

type DeviceSignals = { userAgent: string; mobileHint?: boolean; touchPoints: number; screenWidth: number; screenHeight: number; coarsePointer: boolean };
/** Best-effort phone policy, not an authoritative device identity. Uses screen size, not a resized chat pane. */
export function isPhoneDevice(signals: DeviceSignals): boolean {
  const { userAgent: ua, mobileHint, touchPoints, screenWidth, screenHeight, coarsePointer } = signals;
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1)) return false;
  if (/iPhone|iPod|Windows Phone/i.test(ua)) return true;
  if (/Android/i.test(ua)) return /Mobile/i.test(ua);
  if (mobileHint === true) return true;
  const shortSide = Math.min(screenWidth, screenHeight);
  return coarsePointer && touchPoints > 0 && shortSide > 0 && shortSide < 600;
}
export function usePhoneDevice() {
  const read = () => isPhoneDevice({
    userAgent: navigator.userAgent,
    mobileHint: (navigator as Navigator & { userAgentData?: { mobile: boolean } }).userAgentData?.mobile,
    touchPoints: navigator.maxTouchPoints,
    screenWidth: window.screen.width, screenHeight: window.screen.height,
    coarsePointer: window.matchMedia('(pointer: coarse)').matches,
  });
  const [phone, setPhone] = useState(read);
  useEffect(() => {
    const media = window.matchMedia('(pointer: coarse)');
    const update = () => setPhone(read());
    window.addEventListener('resize', update); media.addEventListener('change', update);
    return () => { window.removeEventListener('resize', update); media.removeEventListener('change', update); };
  }, []);
  return phone;
}
