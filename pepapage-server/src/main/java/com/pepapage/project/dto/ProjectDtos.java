package com.pepapage.project.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.math.BigDecimal;
import java.util.List;

public final class ProjectDtos {

    private ProjectDtos() {
    }

    /** 第一步：创建项目记录（status=uploading），拿到 id 后再申请上传凭证。 */
    public record CreateProjectRequest(
            @Size(max = 200, message = "项目名称最多 200 字") String title,
            @NotBlank(message = "书籍文件名不能为空") String sourceFileName,
            Long folderId,
            @NotBlank @Pattern(regexp = "single|multi|tts", message = "铺码模式不正确") String audioMode,
            @Pattern(regexp = "Bella|Luna|Rosie|Kiki|Jasper|Bruno|Hugo|Leo", message = "声线不正确") String ttsVoice,
            @DecimalMin(value = "0.5", message = "语速范围 0.5-1.5") @DecimalMax(value = "1.5", message = "语速范围 0.5-1.5") BigDecimal ttsSpeed) {
    }

    /** kind: source（书籍 PDF）/ audio（单音频整书音频）/ multi_audio（多音频之一）/ custom_audio（区域自定义音频，需 boxKey） */
    public record UploadPolicyRequest(
            @NotBlank @Pattern(regexp = "source|audio|multi_audio|custom_audio", message = "文件类型不正确") String kind,
            @NotBlank(message = "文件名不能为空") String fileName,
            @Size(max = 200) String boxKey) {
    }

    public record ConfirmOcrRequest(Integer sentenceCount) {
    }

    public record CreateExportRequest(
            @NotBlank @Pattern(regexp = "oid_zip|pdf", message = "导出类型不正确") String type) {
    }

    public record CoursewareExportRequest(List<Long> projectIds, List<Long> folderIds) {
    }

    public record SubmitAudioFile(@NotBlank String fileKey, @NotBlank String originalName) {
    }

    /** 第三步：文件直传 OSS 完成后提交，开始制作。 */
    public record SubmitProjectRequest(
            @NotBlank(message = "缺少书籍文件") String sourceFileKey,
            String audioFileKey,
            List<@Valid SubmitAudioFile> audioFiles) {
    }

    public record RenameProjectRequest(@NotBlank(message = "项目名称不能为空") @Size(max = 200) String title) {
    }

    /** folderId 为 null 表示移到根目录 */
    public record MoveProjectsRequest(@NotEmpty(message = "请选择项目") List<Long> ids, Long folderId) {
    }

    public record BatchDeleteRequest(@NotEmpty(message = "请选择项目") List<Long> ids) {
    }
}
