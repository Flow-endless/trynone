package com.huyingxxi.deepseek.multimodal;

import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.CRC32;

public final class MultimodalHeuristicUtil {
    private MultimodalHeuristicUtil() {
    }

    public static long stableFileHash(MultipartFile file) {
        CRC32 crc = new CRC32();
        byte[] buffer = new byte[4096];
        int total = 0;
        int maxBytes = 64 * 1024;
        try (InputStream in = file.getInputStream()) {
            int n;
            while ((n = in.read(buffer)) > 0 && total < maxBytes) {
                int use = Math.min(n, maxBytes - total);
                crc.update(buffer, 0, use);
                total += use;
            }
        } catch (IOException ignored) {
            byte[] fallback = (file.getOriginalFilename() + ":" + file.getSize())
                    .getBytes(StandardCharsets.UTF_8);
            crc.update(fallback, 0, fallback.length);
        }
        return crc.getValue();
    }

    public static int bounded(long seed, int min, int maxInclusive) {
        if (maxInclusive <= min) return min;
        int range = maxInclusive - min + 1;
        int v = (int) (Math.abs(seed) % range);
        return min + v;
    }

    public static double boundedDouble(long seed, double min, double max) {
        if (max <= min) return min;
        double normalized = (Math.abs(seed % 10000) / 10000.0);
        return min + (max - min) * normalized;
    }
}
