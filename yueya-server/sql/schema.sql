CREATE DATABASE IF NOT EXISTS yueya DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE yueya;

CREATE TABLE IF NOT EXISTS sys_user (
    id            BIGINT       NOT NULL PRIMARY KEY,
    email         VARCHAR(128) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    nickname      VARCHAR(64)  NULL,
    created_at    DATETIME     NOT NULL,
    updated_at    DATETIME     NOT NULL,
    deleted       TINYINT      NOT NULL DEFAULT 0,
    UNIQUE KEY uk_email (email)
) COMMENT '用户';

CREATE TABLE IF NOT EXISTS book_folder (
    id         BIGINT      NOT NULL PRIMARY KEY,
    user_id    BIGINT      NOT NULL,
    parent_id  BIGINT      NULL COMMENT 'NULL 表示根目录',
    name       VARCHAR(100) NOT NULL,
    created_at DATETIME    NOT NULL,
    updated_at DATETIME    NOT NULL,
    deleted    TINYINT     NOT NULL DEFAULT 0,
    KEY idx_user_parent (user_id, parent_id)
) COMMENT '绘本文件夹';

CREATE TABLE IF NOT EXISTS book_project (
    id                 BIGINT       NOT NULL PRIMARY KEY,
    user_id            BIGINT       NOT NULL,
    folder_id          BIGINT       NULL,
    title              VARCHAR(200) NOT NULL,
    audio_mode         VARCHAR(16)  NOT NULL COMMENT 'single / multi / tts',
    source_type        VARCHAR(16)  NOT NULL DEFAULT 'pdf',
    source_file_key    VARCHAR(512) NULL COMMENT 'OSS key: book.pdf',
    cover_key          VARCHAR(512) NULL,
    audio_file_key     VARCHAR(512) NULL COMMENT 'single 模式整书音频',
    audio_files        JSON         NULL COMMENT 'multi 模式 [{fileKey, originalName}]',
    tts_voice          VARCHAR(32)  NULL,
    tts_speed          DECIMAL(3,1) NULL,
    status             VARCHAR(16)  NOT NULL COMMENT 'uploading / processing / completed / failed',
    processing_steps   JSON         NULL COMMENT '[{key, status, progress}]，顺序 ocr→audio_conversion→transcription→alignment',
    current_step_index INT          NOT NULL DEFAULT 0,
    processing_error   VARCHAR(1000) NULL,
    ocr_confirmed      TINYINT      NOT NULL DEFAULT 0,
    page_count         INT          NULL,
    duration_seconds   DECIMAL(10,3) NULL,
    metadata           JSON         NULL,
    created_at         DATETIME     NOT NULL,
    updated_at         DATETIME     NOT NULL,
    deleted            TINYINT      NOT NULL DEFAULT 0,
    KEY idx_user_folder (user_id, folder_id),
    KEY idx_user_status (user_id, status)
) COMMENT '绘本项目';

CREATE TABLE IF NOT EXISTS process_task (
    id          BIGINT      NOT NULL PRIMARY KEY,
    user_id     BIGINT      NOT NULL,
    project_id  BIGINT      NOT NULL,
    task_type   VARCHAR(32) NOT NULL COMMENT 'book_full / book_realign / book_tts / book_export / library_asr',
    status      VARCHAR(16) NOT NULL COMMENT 'queued / running / succeeded / failed',
    error       VARCHAR(1000) NULL,
    created_at  DATETIME    NOT NULL,
    updated_at  DATETIME    NOT NULL,
    KEY idx_project (project_id),
    KEY idx_user_status (user_id, status)
) COMMENT '处理任务';

CREATE TABLE IF NOT EXISTS book_export (
    id          BIGINT       NOT NULL PRIMARY KEY,
    user_id     BIGINT       NOT NULL,
    project_id  BIGINT       NOT NULL,
    task_id     BIGINT       NULL,
    type        VARCHAR(16)  NOT NULL COMMENT 'oid_zip / pdf',
    status      VARCHAR(16)  NOT NULL COMMENT 'queued / running / succeeded / failed',
    progress    INT          NOT NULL DEFAULT 0,
    error       VARCHAR(1000) NULL,
    file_name   VARCHAR(512) NULL COMMENT '导出文件 OSS key',
    created_at  DATETIME     NOT NULL,
    updated_at  DATETIME     NOT NULL,
    KEY idx_project (project_id),
    KEY idx_user (user_id)
) COMMENT '点读导出任务';
