package com.pepapage.storage;

import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.common.utils.BinaryUtil;
import com.aliyun.oss.model.DeleteObjectsRequest;
import com.aliyun.oss.model.ListObjectsV2Request;
import com.aliyun.oss.model.ListObjectsV2Result;
import com.aliyun.oss.model.MatchMode;
import com.aliyun.oss.model.OSSObjectSummary;
import com.aliyun.oss.model.PolicyConditions;
import com.pepapage.common.BizException;
import com.pepapage.config.AppProperties;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Date;
import java.util.List;

/**
 * 阿里 OSS 封装。浏览器使用 PostPolicy 直传，下载使用带过期时间的签名 URL，
 * 文件内容不经过本服务。OSS 未配置时服务仍可启动，调用相关接口才报错。
 */
@Slf4j
@Service
public class OssService {

    private final AppProperties.Oss cfg;
    private volatile OSS client;

    public OssService(AppProperties props) {
        this.cfg = props.oss();
    }

    public record UploadPolicy(String host, String key, String policy, String signature,
                               String accessKeyId, long expireAt) {
    }

    /** 签发只能上传到指定 key、限制大小的直传凭证。 */
    public UploadPolicy createUploadPolicy(String key) {
        OSS oss = client();
        long expireAt = System.currentTimeMillis() + cfg.uploadExpireSeconds() * 1000L;
        PolicyConditions conds = new PolicyConditions();
        conds.addConditionItem(PolicyConditions.COND_CONTENT_LENGTH_RANGE, 1, (long) cfg.maxUploadMb() * 1024 * 1024);
        conds.addConditionItem(MatchMode.Exact, PolicyConditions.COND_KEY, key);
        String rawPolicy = oss.generatePostPolicy(new Date(expireAt), conds);
        String encoded = BinaryUtil.toBase64String(rawPolicy.getBytes(StandardCharsets.UTF_8));
        String signature = oss.calculatePostSignature(rawPolicy);
        return new UploadPolicy(bucketHost(), key, encoded, signature, cfg.accessKeyId(), expireAt);
    }

    public String signedGetUrl(String key) {
        Date expiration = new Date(System.currentTimeMillis() + cfg.downloadExpireSeconds() * 1000L);
        URL url = client().generatePresignedUrl(cfg.bucket(), key, expiration);
        return url.toString();
    }

    public boolean exists(String key) {
        return client().doesObjectExist(cfg.bucket(), key);
    }

    /** 删除某前缀下全部对象（用于永久删除项目）。失败只记日志，不影响主流程。 */
    public void deletePrefix(String prefix) {
        if (!cfg.configured()) {
            return;
        }
        try {
            OSS oss = client();
            String token = null;
            do {
                ListObjectsV2Request req = new ListObjectsV2Request(cfg.bucket()).withPrefix(prefix)
                        .withMaxKeys(1000).withContinuationToken(token);
                ListObjectsV2Result res = oss.listObjectsV2(req);
                List<String> keys = res.getObjectSummaries().stream().map(OSSObjectSummary::getKey).toList();
                if (!keys.isEmpty()) {
                    oss.deleteObjects(new DeleteObjectsRequest(cfg.bucket()).withKeys(keys).withQuiet(true));
                }
                token = res.isTruncated() ? res.getNextContinuationToken() : null;
            } while (token != null);
        } catch (Exception e) {
            log.warn("删除 OSS 前缀失败: {}", prefix, e);
        }
    }

    private String bucketHost() {
        String host = cfg.endpoint().replaceFirst("^https?://", "");
        return "https://" + cfg.bucket() + "." + host;
    }

    private OSS client() {
        if (!cfg.configured()) {
            throw new BizException(503, "OSS 未配置，请在 application-local.yml 中填写 pepapage.oss");
        }
        if (client == null) {
            synchronized (this) {
                if (client == null) {
                    client = new OSSClientBuilder().build(cfg.endpoint(), cfg.accessKeyId(), cfg.accessKeySecret());
                }
            }
        }
        return client;
    }

    @PreDestroy
    public void shutdown() {
        if (client != null) {
            client.shutdown();
        }
    }
}
