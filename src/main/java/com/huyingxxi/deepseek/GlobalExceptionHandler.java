package com.huyingxxi.deepseek;

import com.huyingxxi.deepseek.demos.web.Result;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.multipart.MaxUploadSizeExceededException;

@RestControllerAdvice
public class GlobalExceptionHandler {

    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<Result<String>> handleMethodNotSupported(HttpRequestMethodNotSupportedException e) {
        String hint =
                "该 URL 需使用 "
                        + (e.getSupportedHttpMethods() != null && !e.getSupportedHttpMethods().isEmpty()
                                ? e.getSupportedHttpMethods().toString()
                                : "POST")
                        + "（例如在「视频分析」页上传文件）；浏览器地址栏直接打开多为 GET，会失败。";
        Result<String> body = new Result<>(405, hint, null);
        return ResponseEntity.status(HttpStatus.METHOD_NOT_ALLOWED).body(body);
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    public ResponseEntity<Result<String>> handleMaxUpload(MaxUploadSizeExceededException e) {
        Result<String> body =
                new Result<>(413, "上传体积超过服务端限制（见 application.yml spring.servlet.multipart），请压缩视频或改小文件。", null);
        return ResponseEntity.status(HttpStatus.PAYLOAD_TOO_LARGE).body(body);
    }

    // 全局捕获所有异常
    @ExceptionHandler(Exception.class)
    public Result<String> handleException(Exception e) {
        return Result.fail("系统异常：" + flattenMessages(e));
    }

    // 空指针异常
    @ExceptionHandler(NullPointerException.class)
    public Result<String> handleNullPointer(NullPointerException e) {
        return Result.fail("数据为空：" + e.getMessage());
    }

    /** 附带 1～3 层 cause，便于定位 Python 子进程等嵌套错误 */
    private static String flattenMessages(Throwable e) {
        if (e == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        Throwable cur = e;
        int depth = 0;
        while (cur != null && depth < 4) {
            String m = cur.getMessage();
            if (m != null && !m.isEmpty()) {
                if (sb.length() > 0) {
                    sb.append(" | ");
                }
                sb.append(m);
            }
            cur = cur.getCause();
            depth++;
        }
        if (sb.length() == 0) {
            sb.append(e.getClass().getSimpleName());
        }
        return sb.toString();
    }
}
