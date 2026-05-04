package com.huyingxxi.deepseek.demos.web;

public class Result<T> {
    private int code;
    private String msg;
    private T data;

    // 空构造器（必须有，否则反射/序列化会报错）
    public Result() {}

    // 全参数构造器
    public Result(int code, String msg, T data) {
        this.code = code;
        this.msg = msg;
        this.data = data;
    }

    // 成功静态方法
    public static <T> Result<T> success(T data) {
        return new Result<>(200, "操作成功", data);
    }

    // 失败静态方法
    public static <T> Result<T> fail(String msg) {
        return new Result<>(500, msg, null);
    }

    // getter 和 setter（必须有，否则前端无法接收数据）
    public int getCode() { return code; }
    public void setCode(int code) { this.code = code; }
    public String getMsg() { return msg; }
    public void setMsg(String msg) { this.msg = msg; }
    public T getData() { return data; }
    public void setData(T data) { this.data = data; }
}