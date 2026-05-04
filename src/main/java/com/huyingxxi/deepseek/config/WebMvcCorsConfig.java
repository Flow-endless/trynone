package com.huyingxxi.deepseek.config;

import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

/**
 * 开发环境下允许从 Live Server、其他本地端口或 127.0.0.1 访问 /api，避免浏览器跨域导致 Failed to fetch。
 * 生产环境请改为明确域名并配合网关与鉴权。
 */
@Configuration
public class WebMvcCorsConfig implements WebMvcConfigurer {

    @Override
    public void addCorsMappings(CorsRegistry registry) {
        registry.addMapping("/api/**")
                .allowedOriginPatterns(
                        "http://localhost:*",
                        "http://127.0.0.1:*",
                        // file:// 打开页面、或 Origin 为 null 的预览场景，避免仅 POST 被拒
                        "*"
                )
                .allowedMethods("GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH")
                .allowedHeaders("*")
                .maxAge(3600);
    }
}
