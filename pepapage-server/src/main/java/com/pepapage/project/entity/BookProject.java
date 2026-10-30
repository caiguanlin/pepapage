package com.pepapage.project.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import com.baomidou.mybatisplus.extension.handlers.JacksonTypeHandler;
import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

@Data
@TableName(value = "book_project", autoResultMap = true)
public class BookProject {

    @TableId
    private Long id;
    @JsonIgnore
    private Long userId;
    private Long folderId;
    private String title;
    /** single / multi / tts */
    private String audioMode;
    private String sourceType;
    private String sourceFileKey;
    private String coverKey;
    private String audioFileKey;
    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<AudioFile> audioFiles;
    private String ttsVoice;
    private BigDecimal ttsSpeed;
    /** uploading / processing / completed / failed */
    private String status;
    @TableField(typeHandler = JacksonTypeHandler.class)
    private List<ProcessingStep> processingSteps;
    private Integer currentStepIndex;
    private String processingError;
    private Boolean ocrConfirmed;
    private Integer pageCount;
    private BigDecimal durationSeconds;
    @TableField(typeHandler = JacksonTypeHandler.class)
    private Map<String, Object> metadata;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
    @TableLogic
    @JsonIgnore
    private Integer deleted;

    /** 多音频模式的单个音频：fileKey 为内部存储名，originalName 为用户看到的文件名。 */
    public record AudioFile(String fileKey, String originalName) {
    }

    /** key: ocr / audio_conversion / transcription / alignment；status: pending / running / completed / skipped / failed */
    @Data
    public static class ProcessingStep {
        private String key;
        private String status;
        private Integer progress;

        public static ProcessingStep of(String key, String status) {
            ProcessingStep s = new ProcessingStep();
            s.key = key;
            s.status = status;
            s.progress = "skipped".equals(status) ? 100 : 0;
            return s;
        }
    }
}
