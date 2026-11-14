interface MediaTrackConstraintSet {
  focusMode?: ConstrainDOMString;
  zoom?: ConstrainDouble;
}

interface MediaTrackCapabilities {
  zoom?: { min: number; max: number; step?: number };
}

interface Window {
  BarcodeDetector?: new (options: { formats: string[] }) => {
    detect(source: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
  };
  onXBTNativePhoto?: (payload: unknown) => void;
}
