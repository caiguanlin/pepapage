package com.pepapage.export.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import com.fasterxml.jackson.annotation.JsonIgnore;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("book_export")
public class BookExport {
    @TableId
    private Long id;
    @JsonIgnore
    private Long userId;
    private Long projectId;
    private Long taskId;
    /** oid_zip / pdf */
    private String type;
    /** queued / running / succeeded / failed */
    private String status;
    private Integer progress;
    private String error;
    /** OSS key */
    private String fileName;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
