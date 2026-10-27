# Remove a legenda gravada (para testes): inpainting dos pixels claros/vermelhos na faixa da legenda
import sys, subprocess, numpy as np, cv2
src, out, y0f, y1f = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
W, H = 720, 1280
dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", src, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{W}x{H}", "-r", "30", "-i", "-",
                        "-i", src, "-map", "0:v", "-map", "1:a", "-c:a", "copy", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p", out], stdin=subprocess.PIPE)
y0, y1 = int(y0f * H), int(y1f * H)
k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
while True:
    b = dec.stdout.read(W * H * 3)
    if len(b) < W * H * 3: break
    f = np.frombuffer(b, np.uint8).reshape(H, W, 3).copy()
    band = f[y0:y1]
    hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    white = (hsv[..., 2] > 150) & (hsv[..., 1] < 70)
    red = (hsv[..., 2] > 90) & (hsv[..., 1] > 150) & ((hsv[..., 0] < 8) | (hsv[..., 0] > 170))
    green = (hsv[..., 1] > 120) & (hsv[..., 0] > 45) & (hsv[..., 0] < 80) & (hsv[..., 2] > 150)
    m = ((white | red | green) * 255).astype(np.uint8)
    m = cv2.dilate(m, k, iterations=2)
    band[:] = cv2.inpaint(band, m, 5, cv2.INPAINT_TELEA)
    enc.stdin.write(f.tobytes())
enc.stdin.close(); enc.wait()
print("ok", out)
