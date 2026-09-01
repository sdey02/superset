"use client";

import { useEffect, useState } from "react";
import {
	ArchSource,
	detectPlatform,
	Platform,
	type PlatformInfo,
} from "./platform";

const DEFAULT_PLATFORM: PlatformInfo = {
	platform: Platform.Unknown,
	archSource: ArchSource.NotMac,
};

/** Resolves the visitor's platform after mount. */
export function usePlatform(): PlatformInfo {
	const [info, setInfo] = useState<PlatformInfo>(DEFAULT_PLATFORM);

	useEffect(() => {
		let cancelled = false;
		void detectPlatform().then((next) => {
			if (!cancelled) setInfo(next);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	return info;
}
