// Quality profile. The game targets phones: touch devices get the mobile profile; desktops get
// the full one. Override with ?quality=mobile or ?quality=desktop in the URL.

const query = new URLSearchParams(location.search).get('quality');
const touch = matchMedia('(pointer: coarse)').matches;

export const MOBILE = query ? query === 'mobile' : touch;

export const PROFILE = MOBILE
  ? {
      maxPixelRatio: 1.25, // phones report 2-3; 1.25 keeps edges clean at ~1/4 the pixels of 2.5
      minScale: 0.5, // dynamic resolution floor
      msaa: 0,
      shadowMap: 1024,
      shadowExtent: 45, // m, half-size of the sun's shadow box
      softShadows: false,
      viewBlocks: 7, // city blocks kept alive (300 m each): ~1.8 km
      cityDensity: 0.6, // share of buildings and trees per block
      fogScale: 1.5, // denser haze hides the shorter view distance
      farPlane: 2200,
    }
  : {
      maxPixelRatio: 1.5,
      minScale: 0.6,
      msaa: window.devicePixelRatio > 1 ? 2 : 4,
      shadowMap: 2048,
      shadowExtent: 70,
      softShadows: true,
      viewBlocks: 10,
      cityDensity: 1,
      fogScale: 1,
      farPlane: 3000,
    };
