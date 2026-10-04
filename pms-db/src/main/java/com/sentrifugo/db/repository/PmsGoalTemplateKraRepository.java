package com.sentrifugo.db.repository;

import com.sentrifugo.db.entity.PmsGoalTemplateKraEntity;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface PmsGoalTemplateKraRepository extends JpaRepository<PmsGoalTemplateKraEntity, UUID> {

    List<PmsGoalTemplateKraEntity> findByTemplateIdOrderByDisplayOrderAsc(UUID templateId);

    void deleteByTemplateId(UUID templateId);

    boolean existsByKraId(UUID kraId);
}
