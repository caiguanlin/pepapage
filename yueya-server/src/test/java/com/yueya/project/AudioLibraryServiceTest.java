package com.yueya.project;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.yueya.common.BizException;
import com.yueya.project.entity.BookProject;
import com.yueya.project.mapper.BookProjectMapper;
import com.yueya.storage.OssService;
import com.yueya.task.TaskService;
import com.yueya.task.entity.ProcessTask;
import com.yueya.task.mapper.ProcessTaskMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AudioLibraryServiceTest {

    private static final long USER_ID = 7L;
    private static final long PROJECT_ID = 11L;
    private static final String PREFIX = "users/7/book-projects/11/";
    private static final String FILE = "custom-audio-lib-mh3k2a9xq1.mp3";
    private static final String MANIFEST_KEY = PREFIX + AudioLibraryService.MANIFEST_FILE;

    @Mock
    private BookProjectService projectService;
    @Mock
    private ProjectFileService fileService;
    @Mock
    private OssService ossService;
    @Mock
    private TaskService taskService;
    @Mock
    private ProcessTaskMapper taskMapper;
    @Mock
    private BookProjectMapper projectMapper;

    private ObjectMapper objectMapper;
    private AudioLibraryService service;

    /** library-progress 里更新 process_task 用到 lambdaUpdate，需要实体元数据。 */
    @BeforeAll
    static void initMybatisLambdaCache() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), ""), ProcessTask.class);
    }

    @BeforeEach
    void setUp() {
        objectMapper = new ObjectMapper();
        service = new AudioLibraryService(projectService, fileService, ossService, taskService,
                taskMapper, projectMapper, objectMapper);
    }

    private BookProject project() {
        BookProject p = new BookProject();
        p.setId(PROJECT_ID);
        p.setUserId(USER_ID);
        p.setAudioMode("single");
        when(projectService.requireOwned(USER_ID, PROJECT_ID)).thenReturn(p);
        return p;
    }

    /** library-progress 走任务 → 项目查找，不走 requireOwned。 */
    private BookProject projectForProgress() {
        BookProject p = new BookProject();
        p.setId(PROJECT_ID);
        p.setUserId(USER_ID);
        p.setAudioMode("single");
        when(projectMapper.selectById(PROJECT_ID)).thenReturn(p);
        return p;
    }

    private void givenManifest(String manifestJson) {
        when(ossService.getObject(MANIFEST_KEY)).thenReturn(
                manifestJson == null ? null : manifestJson.getBytes(StandardCharsets.UTF_8));
    }

    private static String manifest(String... items) {
        return "{\"version\":1,\"items\":[" + String.join(",", items) + "]}";
    }

    private static String item(String fileName, String status, String taskId) {
        return "{\"fileName\":\"" + fileName + "\",\"originalName\":\"page3.mp3\",\"status\":\"" + status
                + "\",\"progress\":0,\"error\":null,\"duration\":null,\"lineCount\":null,\"wordCount\":null,"
                + "\"asrFile\":null,\"taskId\":\"" + taskId + "\","
                + "\"createdAt\":\"2026-10-31T08:00:00Z\",\"updatedAt\":\"2026-10-31T08:00:00Z\"}";
    }

    private static ProcessTask task(long taskId) {
        ProcessTask t = new ProcessTask();
        t.setId(taskId);
        t.setProjectId(PROJECT_ID);
        t.setUserId(USER_ID);
        return t;
    }

    private List<String> manifestWrites() {
        ArgumentCaptor<String> json = ArgumentCaptor.forClass(String.class);
        verify(ossService, times(2)).putJson(eq(MANIFEST_KEY), json.capture());
        return json.getAllValues();
    }

    @Test
    void addNewAppendsItemAndBackfillsTaskId() throws Exception {
        project();
        when(ossService.exists(PREFIX + FILE)).thenReturn(true);
        givenManifest(null); // 清单文件不存在
        ProcessTask t = task(190L);
        when(taskService.enqueue(any(), eq("library_asr"), eq(Map.of("fileName", FILE)))).thenReturn(t);

        AudioLibraryService.LibraryItem item =
                service.add(USER_ID, PROJECT_ID, new AudioLibraryService.AddRequest(FILE, "page3.mp3"));

        assertEquals("queued", item.status());
        assertEquals("page3.mp3", item.originalName());
        assertEquals(0, item.progress());
        assertEquals("190", item.taskId());
        // 先写清单（taskId 为空）→ 投递任务 → 回填 taskId 后再写一次
        List<String> writes = manifestWrites();
        JsonNode first = objectMapper.readTree(writes.get(0));
        assertTrue(first.get("items").get(0).get("taskId").isNull());
        JsonNode second = objectMapper.readTree(writes.get(1));
        assertEquals("190", second.get("items").get(0).get("taskId").asText());
    }

    @Test
    void addRetriesFailedItemWithResetFields() throws Exception {
        project();
        when(ossService.exists(PREFIX + FILE)).thenReturn(true);
        givenManifest("{\"version\":1,\"items\":[{"
                + "\"fileName\":\"" + FILE + "\",\"originalName\":\"page3.mp3\",\"status\":\"failed\",\"progress\":40,"
                + "\"error\":\"boom\",\"duration\":12.5,\"lineCount\":4,\"wordCount\":30,"
                + "\"asrFile\":\"" + FILE + ".asr.json\",\"taskId\":\"999\","
                + "\"createdAt\":\"2026-10-31T08:00:00Z\",\"updatedAt\":\"2026-10-31T09:00:00Z\"}]}");
        ProcessTask t = task(555L);
        when(taskService.enqueue(any(), eq("library_asr"), eq(Map.of("fileName", FILE)))).thenReturn(t);

        AudioLibraryService.LibraryItem item =
                service.add(USER_ID, PROJECT_ID, new AudioLibraryService.AddRequest(FILE, "page3.mp3"));

        assertEquals("queued", item.status());
        assertEquals(0, item.progress());
        assertNull(item.error());
        assertNull(item.duration());
        assertNull(item.lineCount());
        assertNull(item.wordCount());
        assertNull(item.asrFile());
        assertEquals("555", item.taskId());
        assertEquals("page3.mp3", item.originalName());
        assertEquals("2026-10-31T08:00:00Z", item.createdAt());
        verify(taskService).enqueue(any(), eq("library_asr"), eq(Map.of("fileName", FILE)));
    }

    @Test
    void addQueuedOrRunningItemReturnsAsIsWithoutEnqueue() {
        project();
        when(ossService.exists(PREFIX + FILE)).thenReturn(true);
        givenManifest(manifest(item(FILE, "running", "190")));

        AudioLibraryService.LibraryItem item =
                service.add(USER_ID, PROJECT_ID, new AudioLibraryService.AddRequest(FILE, "page3.mp3"));

        assertEquals("running", item.status());
        assertEquals("190", item.taskId());
        verify(ossService, never()).putJson(anyString(), anyString());
        verify(taskService, never()).enqueue(any(), anyString(), anyMap());
    }

    @Test
    void addRejectsBadPrefixAndJsonName() {
        project();

        BizException e1 = assertThrows(BizException.class, () ->
                service.add(USER_ID, PROJECT_ID, new AudioLibraryService.AddRequest("audio/other.mp3", "a.mp3")));
        assertEquals("音频文件名必须以 custom-audio- 开头", e1.getMessage());

        BizException e2 = assertThrows(BizException.class, () ->
                service.add(USER_ID, PROJECT_ID, new AudioLibraryService.AddRequest(FILE + ".json", "a.mp3")));
        assertEquals("音频文件名不能以 .json 结尾", e2.getMessage());

        verify(ossService, never()).exists(anyString());
        verify(taskService, never()).enqueue(any(), anyString(), anyMap());
    }

    @Test
    void addRejectsMissingOssFile() {
        project();
        when(ossService.exists(PREFIX + FILE)).thenReturn(false);

        BizException e = assertThrows(BizException.class, () ->
                service.add(USER_ID, PROJECT_ID, new AudioLibraryService.AddRequest(FILE, "page3.mp3")));

        assertEquals(404, e.getCode());
        verify(taskService, never()).enqueue(any(), anyString(), anyMap());
    }

    @Test
    void removeDeletesItemFilesAndCleansBindings() throws Exception {
        project();
        givenManifest(manifest(item(FILE, "succeeded", "190"), item("custom-audio-lib-abc.mp3", "queued", null)));
        String bindings = "{\"entries\":{"
                + "\"p1:s0\":{\"fileName\":\"" + FILE + "\",\"originalName\":\"a.mp3\"},"
                + "\"p2:s0\":{\"fileName\":\"custom-audio-old.mp3\"},"
                + "\"p3:s1\":{\"fileName\":\"" + FILE + "\"}}}";
        when(fileService.readJsonByKey(PREFIX + "book-custom-audio.json")).thenReturn(objectMapper.readTree(bindings));

        AudioLibraryService.DeleteResult result = service.remove(USER_ID, PROJECT_ID, FILE);

        assertEquals(List.of("p1:s0", "p3:s1"), result.removedBoxKeys());
        // 清单只剩另一项
        ArgumentCaptor<String> manifestJson = ArgumentCaptor.forClass(String.class);
        verify(ossService).putJson(eq(MANIFEST_KEY), manifestJson.capture());
        JsonNode items = objectMapper.readTree(manifestJson.getValue()).get("items");
        assertEquals(1, items.size());
        assertEquals("custom-audio-lib-abc.mp3", items.get(0).get("fileName").asText());
        // 绑定文件只剩 p2:s0
        ArgumentCaptor<String> bindingJson = ArgumentCaptor.forClass(String.class);
        verify(ossService).putJson(eq(PREFIX + "book-custom-audio.json"), bindingJson.capture());
        JsonNode entries = objectMapper.readTree(bindingJson.getValue()).get("entries");
        assertEquals(1, entries.size());
        assertTrue(entries.has("p2:s0"));
        // 音频文件与识别结果一并删除
        verify(ossService).delete(PREFIX + FILE);
        verify(ossService).delete(PREFIX + FILE + ".asr.json");
    }

    @Test
    void removeCleansFilesAndBindingsEvenWhenItemMissing() {
        project();
        givenManifest(manifest());
        when(fileService.readJsonByKey(PREFIX + "book-custom-audio.json")).thenReturn(null);

        AudioLibraryService.DeleteResult result = service.remove(USER_ID, PROJECT_ID, FILE);

        assertTrue(result.removedBoxKeys().isEmpty());
        verify(ossService, never()).putJson(anyString(), anyString());
        verify(ossService).delete(PREFIX + FILE);
        verify(ossService).delete(PREFIX + FILE + ".asr.json");
    }

    @Test
    void progressSucceededUpdatesItemAndTask() throws Exception {
        when(taskMapper.selectById(190L)).thenReturn(task(190L));
        projectForProgress();
        givenManifest(manifest(item(FILE, "running", "190")));

        AudioLibraryService.LibraryProgressRequest req = new AudioLibraryService.LibraryProgressRequest(
                FILE, "succeeded", 80, null, 12.48, 4, 30, FILE + ".asr.json");
        service.libraryProgress(190L, req);

        ArgumentCaptor<String> json = ArgumentCaptor.forClass(String.class);
        verify(ossService).putJson(eq(MANIFEST_KEY), json.capture());
        JsonNode updated = objectMapper.readTree(json.getValue()).get("items").get(0);
        assertEquals("succeeded", updated.get("status").asText());
        assertEquals(100, updated.get("progress").asInt());
        assertTrue(updated.get("error").isNull());
        assertEquals(12.48, updated.get("duration").asDouble(), 1e-9);
        assertEquals(4, updated.get("lineCount").asInt());
        assertEquals(30, updated.get("wordCount").asInt());
        assertEquals(FILE + ".asr.json", updated.get("asrFile").asText());
        assertEquals("190", updated.get("taskId").asText());
        verify(taskMapper).update(any());
    }

    @Test
    void progressFailedDefaultsError() throws Exception {
        when(taskMapper.selectById(190L)).thenReturn(task(190L));
        projectForProgress();
        givenManifest(manifest(item(FILE, "running", "190")));

        service.libraryProgress(190L, new AudioLibraryService.LibraryProgressRequest(FILE, "failed", null, null,
                null, null, null, null));

        ArgumentCaptor<String> json = ArgumentCaptor.forClass(String.class);
        verify(ossService).putJson(eq(MANIFEST_KEY), json.capture());
        JsonNode updated = objectMapper.readTree(json.getValue()).get("items").get(0);
        assertEquals("failed", updated.get("status").asText());
        assertEquals("识别失败", updated.get("error").asText());
        verify(taskMapper).update(any());
    }

    @Test
    void progressIgnoresStaleTaskId() {
        when(taskMapper.selectById(123L)).thenReturn(task(123L));
        projectForProgress();
        givenManifest(manifest(item(FILE, "running", "999")));

        service.libraryProgress(123L, new AudioLibraryService.LibraryProgressRequest(
                FILE, "succeeded", 100, null, 1.0, 1, 5, FILE + ".asr.json"));

        // 旧任务的迟到回报：清单与任务状态都不动
        verify(ossService, never()).putJson(anyString(), anyString());
        verify(ossService, never()).delete(anyString());
        verify(taskMapper, never()).update(any());
    }

    @Test
    void progressDeletedItemDeletesAsrOnSucceeded() {
        when(taskMapper.selectById(190L)).thenReturn(task(190L));
        projectForProgress();
        givenManifest(manifest());

        service.libraryProgress(190L, new AudioLibraryService.LibraryProgressRequest(
                FILE, "succeeded", 100, null, 1.0, 1, 5, FILE + ".asr.json"));

        verify(ossService).delete(PREFIX + FILE + ".asr.json");
        verify(ossService, never()).putJson(anyString(), anyString());
        verify(taskMapper, never()).update(any());
    }
}
