package com.pepapage.project;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.pepapage.common.BizException;
import com.pepapage.folder.BookFolderService;
import com.pepapage.project.dto.ProjectDtos.UploadPolicyRequest;
import com.pepapage.project.entity.BookProject;
import com.pepapage.project.entity.BookProject.ProcessingStep;
import com.pepapage.project.mapper.BookProjectMapper;
import com.pepapage.storage.OssService;
import com.pepapage.task.TaskService;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.mockito.ArgumentCaptor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class BookProjectServiceTest {

    private static final long USER_ID = 7L;
    private static final long PROJECT_ID = 11L;

    @Mock
    private BookProjectMapper projectMapper;
    @Mock
    private BookFolderService folderService;
    @Mock
    private OssService ossService;
    @Mock
    private TaskService taskService;
    @InjectMocks
    private BookProjectService service;

    /** 没有 Spring 上下文时 lambdaUpdate 需要手动注册实体元数据，否则报 "can not find lambda cache for this entity"。 */
    @BeforeAll
    static void initMybatisLambdaCache() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), ""), BookProject.class);
    }

    private BookProject project(String mode, String status, boolean ocrConfirmed, String... stepStatuses) {
        BookProject p = new BookProject();
        p.setId(PROJECT_ID);
        p.setUserId(USER_ID);
        p.setAudioMode(mode);
        p.setStatus(status);
        p.setOcrConfirmed(ocrConfirmed);
        p.setCurrentStepIndex(3);
        p.setProcessingError("old error");
        List<ProcessingStep> steps = new ArrayList<>();
        for (int i = 0; i < stepStatuses.length; i++) {
            ProcessingStep s = ProcessingStep.of(BookProjectService.STEP_KEYS.get(i), stepStatuses[i]);
            s.setProgress("pending".equals(stepStatuses[i]) ? 0 : 100);
            steps.add(s);
        }
        p.setProcessingSteps(steps);
        when(projectMapper.selectById(PROJECT_ID)).thenReturn(p);
        return p;
    }

    private static List<String> statuses(BookProject p) {
        return p.getProcessingSteps().stream().map(ProcessingStep::getStatus).toList();
    }

    @Test
    void completedTtsRealignRedubs() {
        project("tts", "completed", true, "completed", "skipped", "skipped", "completed");

        BookProject p = service.realign(USER_ID, PROJECT_ID, 26);

        verify(taskService).enqueue(any(), eq("book_tts"));
        assertTrue(p.getOcrConfirmed());
        assertEquals(List.of("completed", "skipped", "skipped", "pending"), statuses(p));
        assertEquals(0, p.getProcessingSteps().get(3).getProgress());
        assertEquals(3, p.getCurrentStepIndex());
        assertEquals("processing", p.getStatus());
        assertEquals(26, p.getMetadata().get("sentenceCount"));
        assertEquals(null, p.getProcessingError());
        verify(projectMapper).updateById(p);
    }

    @Test
    void ttsRealignBeforeOcrCompletedFails() {
        project("tts", "failed", false, "failed", "skipped", "skipped", "pending");

        BizException e = assertThrows(BizException.class, () -> service.realign(USER_ID, PROJECT_ID, null));

        assertEquals("OCR 尚未完成", e.getMessage());
        verify(taskService, never()).enqueue(any(), anyString());
    }

    @Test
    void singleRealignWithFirstThreeCompleted() {
        project("single", "completed", false, "completed", "completed", "completed", "completed");

        BookProject p = service.realign(USER_ID, PROJECT_ID, null);

        verify(taskService).enqueue(any(), eq("book_realign"));
        assertEquals(List.of("completed", "completed", "completed", "pending"), statuses(p));
        assertEquals(3, p.getCurrentStepIndex());
        assertTrue(p.getOcrConfirmed());
    }

    @Test
    void singleRealignWithSkippedStepFallsBackToFullRetry() {
        project("single", "completed", false, "completed", "skipped", "completed", "completed");

        BookProject p = service.realign(USER_ID, PROJECT_ID, null);

        verify(taskService).enqueue(any(), eq("book_full"));
        assertEquals(List.of("pending", "pending", "pending", "pending"), statuses(p));
        assertEquals(0, p.getCurrentStepIndex());
    }

    @Test
    void failedTtsRetryResetsOcrConfirmation() {
        project("tts", "failed", true, "completed", "skipped", "skipped", "failed");

        BookProject p = service.retry(USER_ID, PROJECT_ID);

        verify(taskService).enqueue(any(), eq("book_full"));
        assertFalse(p.getOcrConfirmed());
        assertEquals("processing", p.getStatus());
        assertEquals(0, p.getCurrentStepIndex());
        assertEquals(List.of("pending", "skipped", "skipped", "pending"), statuses(p));
        assertEquals(null, p.getProcessingError());
    }

    @Test
    void confirmOcrRejectsNonTts() {
        project("single", "completed", false, "completed", "completed", "completed", "completed");

        BizException e = assertThrows(BizException.class, () -> service.confirmOcr(USER_ID, PROJECT_ID, null));

        assertEquals("仅无音频（TTS）模式需要确认 OCR", e.getMessage());
        verify(taskService, never()).enqueue(any(), anyString());
    }

    @Test
    void confirmOcrOnTtsEnqueuesTts() {
        project("tts", "processing", false, "completed", "skipped", "skipped", "pending");

        BookProject p = service.confirmOcr(USER_ID, PROJECT_ID, 5);

        verify(taskService).enqueue(any(), eq("book_tts"));
        assertTrue(p.getOcrConfirmed());
        assertEquals(3, p.getCurrentStepIndex());
        assertEquals("processing", p.getStatus());
        assertEquals(5, p.getMetadata().get("sentenceCount"));
    }

    /** 音频库凭证（契约 5.4）：key 为 custom-audio-lib-<base36ts><4位随机>.<ext>，上限 200 MiB，不受项目 status 限制。 */
    @Test
    void uploadPolicyLibraryAudioIgnoresStatus() {
        project("single", "completed", true, "completed", "completed", "completed", "completed");
        OssService.UploadPolicy policy =
                new OssService.UploadPolicy("https://bucket.oss.com", "k", "p", "s", "ak", 1L);
        when(ossService.createUploadPolicy(anyString(), eq(200L * 1024 * 1024))).thenReturn(policy);

        OssService.UploadPolicy result = service.uploadPolicy(USER_ID, PROJECT_ID,
                new UploadPolicyRequest("library_audio", "page3.mp3", null));

        assertEquals(policy, result);
        ArgumentCaptor<String> key = ArgumentCaptor.forClass(String.class);
        verify(ossService).createUploadPolicy(key.capture(), eq(200L * 1024 * 1024));
        assertTrue(key.getValue().matches("users/" + USER_ID + "/book-projects/" + PROJECT_ID
                + "/custom-audio-lib-[0-9a-z]{12,}\\.mp3"));
    }
}
