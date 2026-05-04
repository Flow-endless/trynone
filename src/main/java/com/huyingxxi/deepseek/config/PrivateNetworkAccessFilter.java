package com.huyingxxi.deepseek.config;

import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import javax.servlet.FilterChain;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;

/**
 * Chrome 等对「公网页访问本机 / 私有网络」的 CORS 预检会带
 * {@code Access-Control-Request-Private-Network: true}，必须在响应里带上
 * {@code Access-Control-Allow-Private-Network: true}，否则浏览器会拦截并在前端表现为 Failed to fetch。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class PrivateNetworkAccessFilter extends OncePerRequestFilter {

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        if ("true".equalsIgnoreCase(request.getHeader("Access-Control-Request-Private-Network"))) {
            response.addHeader("Access-Control-Allow-Private-Network", "true");
        }
        filterChain.doFilter(request, response);
    }
}
