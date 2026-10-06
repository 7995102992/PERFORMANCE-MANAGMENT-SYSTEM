package com.sentrifugo.db.entity;

import com.sentrifugo.db.enums.PmsNotificationAudience;
import com.sentrifugo.db.enums.PmsNotificationStatus;
import jakarta.persistence.*;
import lombok.*;
import lombok.experimental.SuperBuilder;

import java.time.LocalDateTime;
import java.util.UUID;

/** Screen 1.6 - notification sent to one audience when a cycle is published. */
@Entity
@Table(
        name = "pms_cycle_notification",
        schema = "pms",
        indexes = {
                @Index(name = "idx_pms_cycle_notification_cycle", columnList = "cycle_id"),
                @Index(name = "idx_pms_cycle_notification_audience", columnList = "audience"),
                @Index(name = "idx_pms_cycle_notification_status", columnList = "status")
        }
)
@Getter
@Setter
@SuperBuilder
@NoArgsConstructor
@AllArgsConstructor
public class PmsCycleNotificationEntity extends BaseEntity<UUID> {

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "cycle_id", nullable = false)
    private PmsCycleEntity cycle;

    @Enumerated(EnumType.STRING)
    @Column(name = "audience", nullable = false, length = 40)
    private PmsNotificationAudience audience;

    @Column(name = "sent_count", nullable = false)
    @Builder.Default
    private Integer sentCount = 0;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 20)
    private PmsNotificationStatus status;

    @Column(name = "sent_on")
    private LocalDateTime sentOn;

    @Column(name = "error_message", columnDefinition = "TEXT")
    private String errorMessage;
}
