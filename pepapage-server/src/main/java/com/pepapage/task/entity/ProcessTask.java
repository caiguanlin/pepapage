package com.pepapage.task.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("process_task")
public class ProcessTask {
    @TableId
    private Long id;
    private Long userId;
    private Long projectId;
    /** book_full / book_realign / book_tts */
    private String taskType;
    /** queued / running / succeeded / failed */
    private String status;
    private String error;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
