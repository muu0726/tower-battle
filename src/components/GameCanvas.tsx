import { useEffect, useRef } from "react";
import { cameraTarget, createCamera, screenToWorld, updateCamera, type Viewport } from "../game/camera";
import { renderScene } from "../game/renderer";
import type { Scene } from "../game/sandboxScene";

interface Props {
  scene: Scene;
  className?: string;
}

/** Scene を requestAnimationFrame で回し、オートカメラ付きで描画する */
export function GameCanvas({ scene, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const cam = createCamera();
    const view: Viewport = { width: 0, height: 0, dpr: 1 };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      view.width = rect.width;
      view.height = rect.height;
      view.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(rect.width * view.dpr));
      canvas.height = Math.max(1, Math.round(rect.height * view.dpr));
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      scene.update(dt);
      if (view.width > 0 && view.height > 0) {
        updateCamera(cam, cameraTarget(scene.focusTopY(), view), dt);
        renderScene(ctx, view, cam, scene.renderState(), scene.sprites);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const pointer = (phase: "down" | "move" | "up") => (e: PointerEvent) => {
      if (phase === "down") canvas.setPointerCapture(e.pointerId);
      const rect = canvas.getBoundingClientRect();
      scene.onPointer?.(screenToWorld(cam, view, e.clientX - rect.left, e.clientY - rect.top), phase);
    };
    const onDown = pointer("down");
    const onMove = pointer("move");
    const onUp = pointer("up");
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, [scene]);

  return <canvas ref={canvasRef} className={className} style={{ touchAction: "none" }} />;
}
