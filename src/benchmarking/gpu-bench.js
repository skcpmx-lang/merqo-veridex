/**
 * VERIDEX — GPU benchmark (R-08-05).
 *
 * The requirement asks for "a GPU performance test where supported, else UNSUPPORTED", and names
 * the mechanism: a WebGL compute/fill-rate workload in the renderer. That is what this is, and it
 * is deliberately narrow:
 *
 *   - It measures **fill rate and shader throughput through the WebGL path Electron actually
 *     uses**. It does not measure the GPU's peak, a driver's efficiency, or a discrete GPU that
 *     the browser process is not bound to. The notes on the result say so.
 *   - When WebGL is unavailable the result is `UNSUPPORTED` with the reason. It is never replaced
 *     by a CPU rasteriser pretending to be a GPU measurement — the requirement's "alt" column
 *     allows a labelled software fallback, and a label is not a measurement.
 *   - The measurement half needs a browser context, so the renderer runs it (`probeGpu`) and the
 *     main process owns the mapping (`mapGpuBenchmarkResults`) and validates what it is told.
 *
 * Nothing here touches the filesystem, the network, or any setting.
 */

import { Status } from '../core/status.js';
import { field, available, unavailable, failed } from '../core/field.js';

/** Fragment shader: enough arithmetic that the workload cannot be folded into a constant. */
const FRAGMENT_SOURCE = `
precision highp float;
uniform float uSeed;
void main() {
  vec2 p = gl_FragCoord.xy * 0.001 + uSeed;
  float acc = 0.0;
  for (int i = 0; i < 24; i++) {
    acc += sin(p.x * float(i + 1)) * cos(p.y * float(i + 1));
    p += vec2(0.0013, 0.0007) * acc;
  }
  gl_FragColor = vec4(fract(acc), fract(acc * 1.7), fract(acc * 2.3), 1.0);
}`;

const VERTEX_SOURCE = `
attribute vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

/**
 * Compile a shader, returning null and the log rather than throwing into the caller.
 * @param {WebGLRenderingContext} gl
 * @param {number} type
 * @param {string} source
 */
function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return { shader: null, log: 'the context refused to create a shader' };
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    return { shader: null, log: gl.getShaderInfoLog(shader) ?? 'shader compilation failed' };
  }
  return { shader, log: null };
}

/**
 * Run the GPU workload.
 *
 * @param {{
 *   canvas?: {width:number, height:number, getContext:(id:string)=>any},
 *   frames?: number,
 *   width?: number,
 *   height?: number,
 *   now?: () => number
 * }} [options]
 * @returns {{
 *   supported: boolean,
 *   reason: string|null,
 *   renderer: string|null,
 *   vendor: string|null,
 *   frames: number,
 *   frameTimeMs: number|null,
 *   fps: number|null,
 *   pixelsPerSecond: number|null,
 *   error: string|null
 * }}
 */
export function probeGpu(options = {}) {
  const unsupported = (reason) => ({
    supported: false,
    reason,
    renderer: null,
    vendor: null,
    frames: 0,
    frameTimeMs: null,
    fps: null,
    pixelsPerSecond: null,
    error: null
  });

  const canvas = options.canvas ?? null;
  if (!canvas || typeof canvas.getContext !== 'function') {
    return unsupported('No canvas is available, so no WebGL context could be created. This is what a sandboxed or headless session looks like.');
  }

  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
  if (!gl) {
    return unsupported('WebGL is not available in this session, so GPU performance cannot be measured. VERIDEX does not substitute a software rasteriser and label it a GPU result.');
  }

  const debugInfo = gl.getExtension?.('WEBGL_debug_renderer_info') ?? null;
  const renderer = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '') || null : null;
  const vendor = debugInfo ? String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '') || null : null;

  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SOURCE);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
  if (!vertex.shader || !fragment.shader) {
    return {
      ...unsupported('The WebGL driver refused to compile the benchmark shaders, so no measurement was taken.'),
      renderer,
      vendor,
      error: vertex.log ?? fragment.log ?? 'shader compilation failed'
    };
  }

  const program = gl.createProgram();
  gl.attachShader(program, vertex.shader);
  gl.attachShader(program, fragment.shader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    return { ...unsupported('The WebGL program failed to link.'), renderer, vendor, error: gl.getProgramInfoLog(program) ?? null };
  }

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const width = Number(options.width ?? canvas.width ?? 1024);
  const height = Number(options.height ?? canvas.height ?? 768);
  gl.viewport(0, 0, width, height);
  gl.useProgram(program);

  const frames = Math.max(1, Number(options.frames ?? 30));
  const now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));

  // A warm-up frame: the first draw after a program link pays compilation and upload costs that
  // belong to the driver rather than to the machine's throughput.
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.finish?.();

  try {
    const started = now();
    for (let index = 0; index < frames; index += 1) {
      const seed = gl.getUniformLocation(program, 'uSeed');
      if (seed) gl.uniform1f(seed, index * 0.01);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // Reading a pixel forces the queued work to complete, so the timing measures the GPU rather
    // than the command queue.
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.finish?.();
    const elapsed = Math.max(0.001, now() - started);
    const frameTimeMs = elapsed / frames;
    const pixels = width * height * frames;

    return {
      supported: true,
      reason: null,
      renderer,
      vendor,
      frames,
      frameTimeMs: Math.round(frameTimeMs * 1000) / 1000,
      fps: Math.round((1000 / frameTimeMs) * 10) / 10,
      pixelsPerSecond: Math.round(pixels / (elapsed / 1000)),
      error: null
    };
  } catch (error) {
    return {
      ...unsupported('The GPU workload failed while drawing, so no figure is reported.'),
      renderer,
      vendor,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Turn a probe result into report fields.
 *
 * The mapping lives here, in one place, and is used by the main process: the renderer measures,
 * the main process decides what the measurement means.
 *
 * @param {ReturnType<typeof probeGpu>} result
 */
export function mapGpuBenchmarkResults(result) {
  const source = 'renderer-webgl';
  /** @type {Record<string, import('../core/field.js').FieldValue>} */
  const fields = {};

  if (!result || result.supported !== true) {
    const reason = result?.reason ?? 'WebGL is not available, so no GPU measurement was taken.';
    fields.gpuFillRate = unavailable(reason, source);
    fields.gpuAdapter = unavailable('The WebGL adapter could not be queried', source);
    fields.verdict = field(null, {
      status: Status.UNSUPPORTED,
      source,
      error: reason,
      notes: [
        'The requirement allows UNSUPPORTED here. An unmeasured GPU is reported as unmeasured; it is not reported as slow, and no software fallback is presented as a GPU figure.'
      ]
    });
    return fields;
  }

  fields.gpuFillRate = available(result.pixelsPerSecond, source, {
    unit: 'px/s',
    notes: [
      `Measured over ${result.frames} full-viewport draws at ${result.frameTimeMs} ms per frame (${result.fps} fps).`,
      'This is fill rate and shader throughput through the WebGL path Electron uses. It is not the GPU\'s peak performance, and on a laptop with switchable graphics it may be the integrated adapter.'
    ]
  });
  fields.gpuFrameTime = available(result.frameTimeMs, source, {
    unit: 'ms',
    status: result.frameTimeMs > 33 ? Status.WARNING : Status.PASS,
    notes: result.frameTimeMs > 33 ? ['A frame slower than 33 ms means the workload did not reach 30 fps, which suggests software rendering or a heavily contended GPU.'] : []
  });
  fields.gpuAdapter = available(result.renderer ?? 'The WebGL adapter did not report a name', source, {
    notes: [result.vendor ? `Vendor reported as ${result.vendor}.` : 'The vendor string was not exposed.']
  });
  fields.verdict = field(null, {
    status: Status.UNRATED,
    source,
    error: 'A GPU figure is a measurement of one workload, not a rating. Whether a machine renders well depends on what it is asked to render.',
    notes: ['Comparable between two VERIDEX runs of this workload on the same machine.']
  });
  return fields;
}

/** Fields a GPU run contributes to the responsiveness composite (none when unsupported). */
export function gpuFrameTimeOf(result) {
  return result?.supported === true && Number.isFinite(result.frameTimeMs) ? result.frameTimeMs : null;
}

export { failed };
