// 3-D avatar for the PMO assistant: a calm, enterprise-styled bot head rendered
// with the locally vendored three.js (no CDN, nothing for the user to install).
// Exposes a tiny API the assistant drives: setState / pulse / start / stop.
// Returns null if WebGL isn't available so the caller can keep the SVG fallback.
import * as THREE from './vendor/three.module.min.js';

export function createAvatar3D(container) {
    let renderer;
    try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
        return null;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 20);
    camera.position.set(0, 0.05, 3.4);

    // Soft studio lighting — professional, no harsh contrast.
    scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x0b1228, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.PointLight(0x3b82f6, 14, 0, 2);
    rim.position.set(-3, 1.2, -2);
    scene.add(rim);

    const head = new THREE.Group();
    scene.add(head);

    // Head shell — brand blue, slightly soft finish.
    const shell = new THREE.Mesh(
        new THREE.SphereGeometry(1, 48, 48),
        new THREE.MeshStandardMaterial({ color: 0x2f6df6, roughness: 0.38, metalness: 0.15 }),
    );
    shell.scale.set(1, 1.04, 0.95);
    head.add(shell);

    // Glossy dark face visor inset into the front.
    const visor = new THREE.Mesh(
        new THREE.SphereGeometry(0.9, 48, 48),
        new THREE.MeshStandardMaterial({ color: 0x0c1730, roughness: 0.18, metalness: 0.35 }),
    );
    visor.scale.set(0.78, 0.72, 0.55);
    visor.position.set(0, 0.02, 0.52);
    head.add(visor);

    // Eyes — soft glowing capsules on the visor.
    const eyeMat = new THREE.MeshStandardMaterial({
        color: 0x0c1730,
        emissive: 0x9ed2ff,
        emissiveIntensity: 1.6,
        roughness: 0.4,
    });
    const eyeGeo = new THREE.SphereGeometry(0.085, 24, 24);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    const eyeR = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.scale.set(1, 1.45, 0.5);
    eyeR.scale.set(1, 1.45, 0.5);
    eyeL.position.set(-0.26, 0.14, 0.97);
    eyeR.position.set(0.26, 0.14, 0.97);
    head.add(eyeL, eyeR);

    // Mouth — a small capsule that scales while speaking.
    const mouth = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.045, 0.26, 6, 12),
        new THREE.MeshStandardMaterial({
            color: 0x0c1730,
            emissive: 0x9ed2ff,
            emissiveIntensity: 1.1,
            roughness: 0.4,
        }),
    );
    mouth.rotation.z = Math.PI / 2;
    mouth.position.set(0, -0.24, 0.95);
    head.add(mouth);

    // Listening ring — pulses around the head while the mic is open.
    const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.32, 0.018, 12, 72),
        new THREE.MeshBasicMaterial({ color: 0x60a5fa, transparent: true, opacity: 0 }),
    );
    scene.add(ring);

    // Thinking dots — three small spheres that orbit above while interpreting.
    const dots = new THREE.Group();
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0 });
    for (let i = 0; i < 3; i++) {
        const d = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 12), dotMat);
        dots.add(d);
    }
    dots.position.set(0, 1.32, 0);
    scene.add(dots);

    // ---- animation state ----
    let state = 'idle';
    let mouthLevel = 0; // decaying pulse driven by TTS word boundaries
    let blinkAt = 2.5; // next blink time (seconds)
    let blinkPhase = -1; // <0 means not blinking
    let running = false;
    let raf = 0;
    const clock = new THREE.Clock();
    let t = 0;

    // Smoothed targets so state changes glide instead of snapping.
    const cur = { tiltX: 0, turnY: 0, ringO: 0, dotsO: 0, eyeI: 1.6 };
    const TARGETS = {
        idle: { tiltX: 0, turnY: 0, ringO: 0, dotsO: 0, eyeI: 1.6 },
        listening: { tiltX: 0.09, turnY: 0, ringO: 0.85, dotsO: 0, eyeI: 2.4 },
        thinking: { tiltX: -0.1, turnY: 0.16, ringO: 0, dotsO: 0.9, eyeI: 1.2 },
        speaking: { tiltX: 0.03, turnY: 0, ringO: 0, dotsO: 0, eyeI: 2.0 },
        confirming: { tiltX: 0.05, turnY: -0.08, ringO: 0, dotsO: 0, eyeI: 2.0 },
    };

    function resize() {
        const w = container.clientWidth || 1;
        const h = container.clientHeight || 1;
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(container);
    resize();

    function frame() {
        if (!running) return;
        raf = requestAnimationFrame(frame);
        const dt = Math.min(clock.getDelta(), 0.05);
        t += dt;

        const tgt = TARGETS[state] || TARGETS.idle;
        const ease = 1 - Math.exp(-6 * dt);
        for (const k of Object.keys(cur)) cur[k] += (tgt[k] - cur[k]) * ease;

        // Gentle idle bob + breathing, always on underneath the state pose.
        head.position.y = Math.sin(t * 1.1) * 0.03;
        head.rotation.x = cur.tiltX + Math.sin(t * 0.9) * 0.012;
        head.rotation.y = cur.turnY + Math.sin(t * 0.55) * 0.05;

        // Blinking.
        if (blinkPhase < 0 && t >= blinkAt) blinkPhase = 0;
        if (blinkPhase >= 0) {
            blinkPhase += dt * 9;
            const s = blinkPhase < 1 ? 1 - blinkPhase : blinkPhase - 1; // close then open
            const sy = Math.max(0.08, s) * 1.45;
            eyeL.scale.y = sy;
            eyeR.scale.y = sy;
            if (blinkPhase >= 2) {
                blinkPhase = -1;
                blinkAt = t + 2 + Math.random() * 3.5;
                eyeL.scale.y = 1.45;
                eyeR.scale.y = 1.45;
            }
        }
        eyeMat.emissiveIntensity = cur.eyeI;

        // Mouth: word-boundary pulses + a subtle murmur while speaking.
        if (state === 'speaking') {
            mouthLevel = Math.max(mouthLevel - dt * 3.2, 0.18 + Math.abs(Math.sin(t * 9.5)) * 0.18);
        } else {
            mouthLevel = Math.max(mouthLevel - dt * 4, 0);
        }
        mouth.scale.y = 1 + mouthLevel * 5.5;
        mouth.scale.x = 1 - mouthLevel * 0.25;

        // Listening ring pulse.
        ring.material.opacity = cur.ringO * (0.55 + 0.45 * Math.sin(t * 4.2));
        const rs = 1 + cur.ringO * 0.05 * Math.sin(t * 4.2);
        ring.scale.set(rs, rs, rs);
        ring.rotation.x = Math.sin(t * 0.4) * 0.25;

        // Thinking dots orbit.
        dotMat.opacity = cur.dotsO;
        dots.children.forEach((d, i) => {
            const a = t * 2.4 + (i * Math.PI * 2) / 3;
            d.position.set(Math.cos(a) * 0.28, Math.sin(a * 2) * 0.05, Math.sin(a) * 0.28);
            const sc = 0.7 + 0.3 * Math.sin(a * 2);
            d.scale.set(sc, sc, sc);
        });

        renderer.render(scene, camera);
    }

    return {
        setState(s) {
            state = TARGETS[s] ? s : 'idle';
        },
        // Pulse the mouth (called on each TTS word boundary).
        pulse(strength = 0.55) {
            mouthLevel = Math.min(1, Math.max(mouthLevel, strength));
        },
        start() {
            if (running) return;
            running = true;
            clock.getDelta();
            frame();
        },
        stop() {
            running = false;
            cancelAnimationFrame(raf);
        },
        dispose() {
            this.stop();
            if (ro) ro.disconnect();
            renderer.dispose();
            renderer.domElement.remove();
        },
    };
}
