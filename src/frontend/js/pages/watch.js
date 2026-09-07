// Watch page (پخش ویدیو): thin wrapper over the videoPlayer component so
// pages/links can `import { openWatch } from './pages/watch.js'`.

export { openVideoPlayer as openWatch, closeVideoPlayer as closeWatch } from '../components/videoPlayer.js';
