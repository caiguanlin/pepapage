package com.pepapage.task;

import com.pepapage.config.AppProperties;
import com.pepapage.project.entity.BookProject;
import com.pepapage.task.entity.ProcessTask;
import com.pepapage.task.mapper.ProcessTaskMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.data.redis.connection.stream.MapRecord;
import org.springframework.data.redis.connection.stream.StreamRecords;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.Map;

/**
 * 任务投递：先写 process_task，事务提交后再 XADD 到 Redis Stream，
 * 避免 worker 读到尚未提交的任务。worker 以消费组方式读取。
 */
@Service
@RequiredArgsConstructor
public class TaskService {

    private final ProcessTaskMapper taskMapper;
    private final StringRedisTemplate redis;
    private final AppProperties props;

    public ProcessTask enqueue(BookProject project, String taskType) {
        return enqueue(project, taskType, Map.of());
    }

    /** extra 为附加消息字段（如导出任务的 exportId、type）。 */
    public ProcessTask enqueue(BookProject project, String taskType, Map<String, String> extra) {
        ProcessTask task = new ProcessTask();
        task.setUserId(project.getUserId());
        task.setProjectId(project.getId());
        task.setTaskType(taskType);
        task.setStatus("queued");
        taskMapper.insert(task);

        Map<String, String> fields = new java.util.LinkedHashMap<>();
        fields.put("taskId", String.valueOf(task.getId()));
        fields.put("projectId", String.valueOf(project.getId()));
        fields.put("taskType", taskType);
        fields.put("audioMode", project.getAudioMode());
        fields.putAll(extra);
        Runnable publish = () -> {
            MapRecord<String, String, String> record = StreamRecords.newRecord()
                    .in(props.worker().taskStream())
                    .ofMap(fields);
            redis.opsForStream().add(record);
        };
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    publish.run();
                }
            });
        } else {
            publish.run();
        }
        return task;
    }
}
