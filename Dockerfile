# 多阶段构建：Spring Boot + Python（图片/音频/视频离线推理需在首次请求时下载模型，冷启动较慢）
FROM eclipse-temurin:17-jdk-jammy AS build
WORKDIR /src
COPY pom.xml .
COPY src ./src
COPY scripts ./scripts
RUN apt-get update \
    && apt-get install -y --no-install-recommends maven \
    && rm -rf /var/lib/apt/lists/*
RUN mvn -q -DskipTests package

FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements-audio.txt requirements-vision.txt ./
COPY scripts ./scripts
RUN pip3 install --no-cache-dir \
    -r requirements-audio.txt \
    -r requirements-vision.txt

COPY --from=build /src/target/*.jar /app/app.jar

ENV SPRING_PROFILES_ACTIVE=docker
# 云上必须配置（勿提交到仓库）
# ENV DEEPSEEK_API_KEY=sk-***

EXPOSE 8080

ENTRYPOINT ["java", "-jar", "/app/app.jar"]
